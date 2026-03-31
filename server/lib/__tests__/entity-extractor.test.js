const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

let extractEquipment, EQUIPMENT_KEYWORDS;

beforeEach(() => {
  installFetchMock();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  jest.isolateModules(() => {
    ({ extractEquipment, EQUIPMENT_KEYWORDS } = require('../entity-extractor'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('EQUIPMENT_KEYWORDS regex', () => {
  it('matches CNC brands', () => {
    expect(EQUIPMENT_KEYWORDS.test('We have three Haas machines')).toBe(true);
    expect(EQUIPMENT_KEYWORDS.test('two Mazak turning centers')).toBe(true);
    expect(EQUIPMENT_KEYWORDS.test('Doosan DNM 5700')).toBe(true);
    expect(EQUIPMENT_KEYWORDS.test('Fanuc Robodrill')).toBe(true);
  });

  it('matches compressor types', () => {
    expect(EQUIPMENT_KEYWORDS.test('old recip compressor')).toBe(true);
    expect(EQUIPMENT_KEYWORDS.test('rotary screw unit')).toBe(true);
    expect(EQUIPMENT_KEYWORDS.test('piston compressor kicks on')).toBe(true);
  });

  it('matches finishing equipment', () => {
    expect(EQUIPMENT_KEYWORDS.test('HVLP spray gun')).toBe(true);
    expect(EQUIPMENT_KEYWORDS.test('DA sander')).toBe(true);
    expect(EQUIPMENT_KEYWORDS.test('blast cabinet')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(EQUIPMENT_KEYWORDS.test('How is business going?')).toBe(false);
    expect(EQUIPMENT_KEYWORDS.test('The weather is nice today')).toBe(false);
    expect(EQUIPMENT_KEYWORDS.test('Can I send you a quote?')).toBe(false);
    expect(EQUIPMENT_KEYWORDS.test('Talk to Sandra about it')).toBe(false);
  });
});

describe('extractEquipment', () => {
  it('returns empty array for null/empty input', async () => {
    expect(await extractEquipment(null)).toEqual([]);
    expect(await extractEquipment('')).toEqual([]);
    expect(await extractEquipment(123)).toEqual([]);
  });

  it('skips Claude call when no keywords match', async () => {
    const result = await extractEquipment('Just a normal business conversation about pricing');
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls Claude when keywords match and parses response', async () => {
    mockFetchResponse({
      content: [{
        type: 'text',
        text: '[{"manufacturer":"Haas","model":"VF-2","count":3,"raw_mention":"three Haas VF-2s"}]',
      }],
    });

    const result = await extractEquipment('We run three Haas VF-2s on the floor');
    expect(result).toEqual([{
      manufacturer: 'Haas',
      model: 'VF-2',
      count: 3,
      raw_mention: 'three Haas VF-2s',
    }]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('handles markdown-fenced JSON', async () => {
    mockFetchResponse({
      content: [{
        type: 'text',
        text: '```json\n[{"manufacturer":"Mazak","model":"QTN-200","count":2,"raw_mention":"two Mazaks"}]\n```',
      }],
    });

    const result = await extractEquipment('We have two Mazak turning centers');
    expect(result).toHaveLength(1);
    expect(result[0].manufacturer).toBe('Mazak');
  });

  it('handles brand-only mention (no model)', async () => {
    mockFetchResponse({
      content: [{
        type: 'text',
        text: '[{"manufacturer":"Haas","model":null,"count":5,"raw_mention":"five Haas machines"}]',
      }],
    });

    const result = await extractEquipment('We run Haas. Five machines.');
    expect(result[0].model).toBeNull();
    expect(result[0].count).toBe(5);
  });

  it('clamps count to minimum 1', async () => {
    mockFetchResponse({
      content: [{
        type: 'text',
        text: '[{"manufacturer":"Haas","model":"VF-2","count":0,"raw_mention":"a Haas VF-2"}]',
      }],
    });

    const result = await extractEquipment('Got a Haas VF-2');
    expect(result[0].count).toBe(1);
  });

  it('returns empty array on API error', async () => {
    mockFetchResponse('Server error', { status: 500 });
    const result = await extractEquipment('Our Haas VF-2 broke down');
    expect(result).toEqual([]);
  });

  it('returns empty array when ANTHROPIC_API_KEY missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await extractEquipment('We have a Haas VF-2');
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns empty array on malformed JSON', async () => {
    mockFetchResponse({
      content: [{ type: 'text', text: 'not json at all' }],
    });
    const result = await extractEquipment('The Haas machine is down');
    expect(result).toEqual([]);
  });

  it('returns empty array on non-array JSON', async () => {
    mockFetchResponse({
      content: [{ type: 'text', text: '{"manufacturer":"Haas"}' }],
    });
    const result = await extractEquipment('Our Haas is running');
    expect(result).toEqual([]);
  });

  it('returns empty array on fetch timeout', async () => {
    mockFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const result = await extractEquipment('The Doosan machine');
    expect(result).toEqual([]);
  });

  it('returns empty array when content has no text block', async () => {
    mockFetchResponse({ content: [{ type: 'tool_use', id: 'x' }] });
    const result = await extractEquipment('A Fanuc robot');
    expect(result).toEqual([]);
  });

  it('handles multiple equipment in one response', async () => {
    mockFetchResponse({
      content: [{
        type: 'text',
        text: JSON.stringify([
          { manufacturer: 'Haas', model: 'VF-2', count: 3, raw_mention: 'three VF-2s' },
          { manufacturer: 'Mazak', model: 'QTN-200', count: 2, raw_mention: 'two QTN-200s' },
        ]),
      }],
    });
    const result = await extractEquipment('Three Haas VF-2s and two Mazak QTN-200 turning centers');
    expect(result).toHaveLength(2);
    expect(result[0].manufacturer).toBe('Haas');
    expect(result[1].manufacturer).toBe('Mazak');
  });
});
