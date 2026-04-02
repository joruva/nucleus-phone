jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

const { pool } = require('../../db');
const {
  findByManufacturerModel,
  findByVariant,
  findFuzzy,
  insertEquipment,
  logSighting,
  levenshtein,
} = require('../equipment-db');

const SAMPLE_ROW = {
  id: 1,
  manufacturer: 'Haas',
  model: 'VF-2',
  cfm_typical: 12,
  psi_required: 90,
  duty_cycle_pct: 60,
  description: '3-axis vertical mill',
};

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('haas', 'haas')).toBe(0);
  });

  it('returns correct distance for similar strings', () => {
    expect(levenshtein('haas', 'hoss')).toBe(2);
    expect(levenshtein('mazak', 'mazack')).toBe(1);
  });

  it('returns full length for empty vs non-empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
});

describe('findByManufacturerModel', () => {
  it('returns row on exact match', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_ROW] });
    const result = await findByManufacturerModel('Haas', 'VF-2');
    expect(result).toEqual(SAMPLE_ROW);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('LOWER(ec.manufacturer) = LOWER($1)'),
      ['Haas', 'VF-2']
    );
  });

  it('returns null on no match', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await findByManufacturerModel('Haas', 'NONEXISTENT');
    expect(result).toBeNull();
  });

  it('returns null on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection lost'));
    const result = await findByManufacturerModel('Haas', 'VF-2');
    expect(result).toBeNull();
  });
});

describe('findByVariant', () => {
  it('returns row when variant matches', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_ROW] });
    const result = await findByVariant('Haas', 'VF2');
    expect(result).toEqual(SAMPLE_ROW);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('unnest(ec.model_variants)'),
      ['Haas', 'VF2']
    );
  });

  it('returns null on no variant match', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await findByVariant('Haas', 'NOPE');
    expect(result).toBeNull();
  });
});

describe('findFuzzy', () => {
  beforeEach(() => {
    // Default: fuzzystrmatch not available
    const db = require('../../db');
    db.FUZZY_AVAILABLE = false;
  });

  it('uses JS fallback when fuzzystrmatch unavailable', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...SAMPLE_ROW, model: 'VF-2' }],
    });
    const result = await findFuzzy('Haas', 'VF2');
    // 'VF2' vs 'VF-2' = distance 1, should match
    expect(result).toBeTruthy();
    expect(result.model).toBe('VF-2');
  });

  it('rejects matches beyond distance 2', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...SAMPLE_ROW, model: 'VF-6SS' }],
    });
    const result = await findFuzzy('Haas', 'VF2');
    // 'VF2' vs 'VF-6SS' = distance > 2
    expect(result).toBeNull();
  });

  it('uses fuzzystrmatch when available', async () => {
    const db = require('../../db');
    db.FUZZY_AVAILABLE = true;
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_ROW] });
    const result = await findFuzzy('Haas', 'VF2');
    expect(result).toEqual(SAMPLE_ROW);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('levenshtein(LOWER(ec.model)'),
      ['Haas', 'VF2']
    );
  });

  it('returns null on empty model', async () => {
    const result = await findFuzzy('Haas', '');
    expect(result).toBeNull();
  });
});

describe('insertEquipment', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(mockClient);
  });

  it('inserts catalog and details in a transaction', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT catalog
      .mockResolvedValueOnce(undefined) // INSERT details
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await insertEquipment(
      { manufacturer: 'Haas', model: 'VF-2', category: 'cnc_mill', source: 'web_search' },
      { description: 'Vertical mill' }
    );

    expect(result).toEqual({ id: 42 });
    expect(mockClient.query).toHaveBeenCalledTimes(4);
    expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
    expect(mockClient.query.mock.calls[3][0]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('passes all 13 equipment_details columns including key_selling_points and common_objections', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT catalog
      .mockResolvedValueOnce(undefined) // INSERT details
      .mockResolvedValueOnce(undefined); // COMMIT

    const allDetails = {
      description: '3-axis vertical mill',
      typical_applications: 'General machining',
      industries: 'Aerospace, Automotive',
      air_usage_notes: '12 CFM typical',
      common_air_problems: 'Moisture in tool holders',
      recommended_air_quality: 'ISO 8573-1 Class 1.4.1',
      recommended_compressor: 'JRS-15E',
      recommended_dryer: 'RD-15',
      recommended_filters: 'F-series inline',
      system_notes: 'Size for growth',
      key_selling_points: ['Moisture is the #1 issue', 'Size for growth'],
      common_objections: ['Already have a piston compressor', 'Getting quotes from Kaeser'],
    };

    const result = await insertEquipment(
      { manufacturer: 'Haas', model: 'VF-2', category: 'cnc_mill', source: 'web_search' },
      allDetails
    );

    expect(result).toEqual({ id: 99 });
    // Details INSERT is the 3rd query (index 2)
    const detailsCall = mockClient.query.mock.calls[2];
    const sql = detailsCall[0];
    const params = detailsCall[1];

    // SQL includes all 13 columns
    expect(sql).toContain('key_selling_points');
    expect(sql).toContain('common_objections');

    // 13 params: equipment_id + 12 detail fields
    expect(params).toHaveLength(13);
    expect(params[0]).toBe(99); // equipment_id
    expect(params[11]).toEqual(['Moisture is the #1 issue', 'Size for growth']);
    expect(params[12]).toEqual(['Already have a piston compressor', 'Getting quotes from Kaeser']);
  });

  it('rolls back on error', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('constraint violation')) // INSERT catalog fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const result = await insertEquipment(
      { manufacturer: 'Haas', model: 'VF-2', category: 'cnc_mill', source: 'web_search' },
      null
    );

    expect(result.error).toBe(true);
    expect(result.message).toContain('constraint violation');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('skips details insert when detailsData is null', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // INSERT catalog
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await insertEquipment(
      { manufacturer: 'Haas', model: 'VF-2', category: 'cnc_mill', source: 'manufacturer' },
      null
    );

    expect(result).toEqual({ id: 7 });
    // 3 calls: BEGIN, INSERT catalog, COMMIT (no details insert)
    expect(mockClient.query).toHaveBeenCalledTimes(3);
  });
});

describe('logSighting', () => {
  it('inserts a sighting row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await logSighting({
      manufacturer: 'Haas',
      model: 'VF-2',
      raw_mention: 'three Haas VF-2s',
      count: 3,
      call_type: 'practice',
      call_id: 'sim-123',
      caller_identity: 'tom',
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO equipment_sightings'),
      expect.arrayContaining(['Haas', 'VF-2', 'three Haas VF-2s', 3])
    );
  });

  it('returns false on DB error without throwing', async () => {
    pool.query.mockRejectedValueOnce(new Error('timeout'));
    const result = await logSighting({
      raw_mention: 'test',
      call_type: 'real',
    });
    expect(result).toBe(false);
  });
});
