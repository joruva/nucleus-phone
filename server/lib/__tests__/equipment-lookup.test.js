const { installFetchMock, mockFetchResponse } = require('../../__tests__/helpers/mock-fetch');

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../equipment-db');

const equipmentDb = require('../equipment-db');

// Must require after mocks are set up
let lookupEquipment;

beforeEach(() => {
  installFetchMock();
  process.env.ANTHROPIC_API_KEY = 'test-key';

  // isolateModules resets the inFlight dedup map inside equipment-lookup.
  // The equipment-db mock (required above) is unaffected because jest.mock()
  // at the top level makes all require() calls return the same mock singleton.
  jest.isolateModules(() => {
    lookupEquipment = require('../equipment-lookup').lookupEquipment;
  });

  // Default: all lookups miss
  equipmentDb.findByManufacturerModel.mockResolvedValue(null);
  equipmentDb.findByVariant.mockResolvedValue(null);
  equipmentDb.findFuzzy.mockResolvedValue(null);
  equipmentDb.insertEquipment.mockResolvedValue({ id: 1 });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.ANTHROPIC_API_KEY;
  jest.restoreAllMocks();
});

const SAMPLE_RESULT = {
  id: 1,
  manufacturer: 'Haas',
  model: 'VF-2',
  cfm_typical: 12,
};

describe('lookupEquipment', () => {
  it('returns null for empty inputs', async () => {
    expect(await lookupEquipment(null, 'VF-2')).toBeNull();
    expect(await lookupEquipment('Haas', null)).toBeNull();
  });

  it('returns exact match without further lookups', async () => {
    equipmentDb.findByManufacturerModel.mockResolvedValueOnce(SAMPLE_RESULT);
    const result = await lookupEquipment('Haas', 'VF-2');
    expect(result).toEqual(SAMPLE_RESULT);
    expect(equipmentDb.findByVariant).not.toHaveBeenCalled();
    expect(equipmentDb.findFuzzy).not.toHaveBeenCalled();
  });

  it('falls through to variant match', async () => {
    equipmentDb.findByVariant.mockResolvedValueOnce(SAMPLE_RESULT);
    const result = await lookupEquipment('Haas', 'VF2');
    expect(result).toEqual(SAMPLE_RESULT);
    expect(equipmentDb.findByManufacturerModel).toHaveBeenCalled();
    expect(equipmentDb.findByVariant).toHaveBeenCalledWith('Haas', 'VF2');
    expect(equipmentDb.findFuzzy).not.toHaveBeenCalled();
  });

  it('falls through to fuzzy match', async () => {
    equipmentDb.findFuzzy.mockResolvedValueOnce(SAMPLE_RESULT);
    const result = await lookupEquipment('Haas', 'VF2');
    expect(result).toEqual(SAMPLE_RESULT);
    expect(equipmentDb.findFuzzy).toHaveBeenCalledWith('Haas', 'VF2');
  });

  it('calls web search when all DB lookups miss', async () => {
    mockFetchResponse({
      content: [{
        type: 'text',
        text: JSON.stringify({
          manufacturer: 'Haas',
          model: 'VF-2',
          category: 'cnc_mill',
          cfm_typical: 12,
          psi_required: 90,
          duty_cycle_pct: 60,
        }),
      }],
    });
    // After insert, re-fetch returns the row
    equipmentDb.findByManufacturerModel
      .mockResolvedValueOnce(null) // initial lookup
      .mockResolvedValueOnce(SAMPLE_RESULT); // post-insert re-fetch

    const result = await lookupEquipment('Haas', 'VF-2');
    expect(result).toEqual(SAMPLE_RESULT);
    expect(equipmentDb.insertEquipment).toHaveBeenCalledWith(
      expect.objectContaining({
        manufacturer: 'Haas',
        model: 'VF-2',
        source: 'web_search',
        confidence: 'unverified',
      }),
      expect.objectContaining({})
    );
  });

  it('returns null when web search fails', async () => {
    mockFetchResponse('Server error', { status: 500 });
    const result = await lookupEquipment('Unknown', 'X-999');
    expect(result).toBeNull();
  });

  it('returns null when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await lookupEquipment('Unknown', 'X-999');
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('handles malformed JSON from web search', async () => {
    mockFetchResponse({
      content: [{ type: 'text', text: 'not valid json at all' }],
    });
    const result = await lookupEquipment('Unknown', 'X-999');
    expect(result).toBeNull();
  });

  it('handles markdown-fenced JSON from web search', async () => {
    mockFetchResponse({
      content: [{
        type: 'text',
        text: '```json\n{"manufacturer":"Test","model":"T-1","category":"cnc_mill","cfm_typical":5}\n```',
      }],
    });
    equipmentDb.findByManufacturerModel
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 2, manufacturer: 'Test', model: 'T-1' });

    const result = await lookupEquipment('Test', 'T-1');
    expect(result).toBeTruthy();
    expect(equipmentDb.insertEquipment).toHaveBeenCalled();
  });
});
