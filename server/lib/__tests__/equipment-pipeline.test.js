const {
  detectAirQualityContext, AQ_CONTEXT_PATTERNS, supersedeGenerics,
  inferCategory, SUPERSEDE_WINDOW, RESET_TRIGGER,
} = require('../equipment-pipeline');

describe('detectAirQualityContext', () => {
  it('detects AS9100 as ISO_8573_1', () => {
    expect(detectAirQualityContext('We run AS9100 aerospace work')).toBe('ISO_8573_1');
  });

  it('detects AS-9100 with hyphen', () => {
    expect(detectAirQualityContext('certified to AS-9100')).toBe('ISO_8573_1');
  });

  it('detects AS 9100 with space', () => {
    expect(detectAirQualityContext('our AS 9100 environment')).toBe('ISO_8573_1');
  });

  it('detects aerospace keyword', () => {
    expect(detectAirQualityContext('we do aerospace bracket work')).toBe('ISO_8573_1');
  });

  it('detects pharmaceutical', () => {
    expect(detectAirQualityContext('pharmaceutical manufacturing facility')).toBe('ISO_8573_1');
  });

  it('detects pharma abbreviation', () => {
    expect(detectAirQualityContext('we are a pharma company')).toBe('ISO_8573_1');
  });

  it('detects ISO 8573', () => {
    expect(detectAirQualityContext('ISO 8573 class 1 air quality')).toBe('ISO_8573_1');
  });

  it('detects medical device', () => {
    expect(detectAirQualityContext('medical device manufacturing')).toBe('ISO_8573_1');
  });

  it('detects clean room', () => {
    expect(detectAirQualityContext('we have a clean room')).toBe('ISO_8573_1');
  });

  it('detects paint booth as paint_grade', () => {
    expect(detectAirQualityContext('we run a paint booth')).toBe('paint_grade');
  });

  it('detects spray booth as paint_grade', () => {
    expect(detectAirQualityContext('our spray booth needs clean air')).toBe('paint_grade');
  });

  it('detects auto body as paint_grade', () => {
    expect(detectAirQualityContext('auto body shop')).toBe('paint_grade');
  });

  it('detects powder coat as paint_grade', () => {
    expect(detectAirQualityContext('we do powder coating')).toBe('paint_grade');
  });

  it('returns null for general machining text', () => {
    expect(detectAirQualityContext('we run five CNC machines')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(detectAirQualityContext('')).toBeNull();
  });

  it('ISO_8573_1 wins over paint_grade when both present', () => {
    expect(detectAirQualityContext('aerospace paint booth operations')).toBe('ISO_8573_1');
  });

  it('is case insensitive', () => {
    expect(detectAirQualityContext('AEROSPACE manufacturing')).toBe('ISO_8573_1');
    expect(detectAirQualityContext('Paint Booth')).toBe('paint_grade');
  });
});

describe('resolveAirQuality', () => {
  const { resolveAirQuality } = require('../equipment-pipeline');
  const { setCallAirQuality, cleanupCall } = require('../live-analysis');

  const testCallIds = [];
  afterAll(() => { for (const id of testCallIds) cleanupCall(id); });
  function trackCall(id) { testCallIds.push(id); return id; }

  it('returns null when equipment is general and no context', () => {
    const accumulated = [{ air_quality_class: 'general' }];
    expect(resolveAirQuality(accumulated, 'test-no-context')).toBeNull();
  });

  it('returns paint_grade from equipment when no context override', () => {
    const accumulated = [
      { air_quality_class: 'general' },
      { air_quality_class: 'paint_grade' },
    ];
    expect(resolveAirQuality(accumulated, 'test-paint-equip')).toBe('paint_grade');
  });

  it('returns ISO_8573_1 from equipment when present', () => {
    const accumulated = [
      { air_quality_class: 'general' },
      { air_quality_class: 'ISO_8573_1' },
    ];
    expect(resolveAirQuality(accumulated, 'test-iso-equip')).toBe('ISO_8573_1');
  });

  it('context overrides general equipment to ISO_8573_1 (the Mike Garza case)', () => {
    const callId = trackCall('test-context-override');
    setCallAirQuality(callId, 'ISO_8573_1');
    const accumulated = [
      { air_quality_class: 'general' },  // CNC machines default to general
      { air_quality_class: 'general' },
    ];
    expect(resolveAirQuality(accumulated, callId)).toBe('ISO_8573_1');
  });

  it('context overrides general equipment to paint_grade', () => {
    const callId = trackCall('test-context-paint');
    setCallAirQuality(callId, 'paint_grade');
    const accumulated = [{ air_quality_class: 'general' }];
    expect(resolveAirQuality(accumulated, callId)).toBe('paint_grade');
  });

  it('ISO_8573_1 context wins over paint_grade equipment', () => {
    const callId = trackCall('test-iso-over-paint');
    setCallAirQuality(callId, 'ISO_8573_1');
    const accumulated = [{ air_quality_class: 'paint_grade' }];
    expect(resolveAirQuality(accumulated, callId)).toBe('ISO_8573_1');
  });

  it('equipment ISO_8573_1 wins over paint_grade context', () => {
    const callId = trackCall('test-equip-over-context');
    setCallAirQuality(callId, 'paint_grade');
    const accumulated = [{ air_quality_class: 'ISO_8573_1' }];
    expect(resolveAirQuality(accumulated, callId)).toBe('ISO_8573_1');
  });
});

describe('AQ_CONTEXT_PATTERNS coverage', () => {
  it('every pattern has at least one matching test case above', () => {
    const testInputs = [
      'AS9100', 'aerospace', 'pharma', 'ISO 8573',
      'medical device', 'clean room',
      'paint booth', 'spray booth', 'auto body', 'powder coating',
    ];
    for (const { re } of AQ_CONTEXT_PATTERNS) {
      const matched = testInputs.some(input => re.test(input));
      expect(matched).toBe(true);
    }
  });
});

// ─── inferCategory ──────────────────────────────────────────────────────────

describe('inferCategory', () => {
  it('maps CNC manufacturers to cnc', () => {
    expect(inferCategory({ manufacturer: 'Haas', model: 'VF-2' })).toBe('cnc');
    expect(inferCategory({ manufacturer: 'Mazak', model: 'QTN-200' })).toBe('cnc');
    expect(inferCategory({ manufacturer: 'Doosan', model: 'DNM-5700' })).toBe('cnc');
  });

  it('is case-insensitive on manufacturer', () => {
    expect(inferCategory({ manufacturer: 'HAAS', model: 'VF-2' })).toBe('cnc');
    expect(inferCategory({ manufacturer: 'mazak', model: null })).toBe('cnc');
  });

  it('matches category keywords in raw_mention', () => {
    expect(inferCategory({ manufacturer: null, model: null, raw_mention: 'paint booth' })).toBe('paint');
    expect(inferCategory({ manufacturer: null, model: null, raw_mention: 'blast cabinet' })).toBe('blast');
    expect(inferCategory({ manufacturer: null, model: null, raw_mention: 'packaging line' })).toBe('packaging');
  });

  it('returns null for unrecognized equipment', () => {
    expect(inferCategory({ manufacturer: 'Unknown', model: 'X-1' })).toBeNull();
    expect(inferCategory({ manufacturer: null, model: null, raw_mention: 'desk chair' })).toBeNull();
  });
});

// ─── supersedeGenerics (bd-597: equipment double-counting fix) ──────────────

describe('supersedeGenerics', () => {
  function makeGeneric(category, count, chunkNum) {
    return {
      cfm_typical: 8, duty_cycle_pct: 75, psi_required: 90,
      air_quality_class: 'general', count,
      _meta: {
        isGeneric: true, category, chunkNum,
        manufacturer: null, model: null, confidence: 'category_default',
        rawMention: '',
      },
    };
  }

  function makeSpecific(mfg, model, category, count, chunkNum) {
    return {
      cfm_typical: 8, duty_cycle_pct: 75, psi_required: 90,
      air_quality_class: 'general', count,
      _meta: {
        isGeneric: false, category, chunkNum,
        manufacturer: mfg, model, confidence: 'catalog',
        rawMention: '',
      },
    };
  }

  it('reduces generic count when specific arrives (the Kate scenario)', () => {
    const accumulated = [makeGeneric('cnc', 5, 1)];
    const consumed = supersedeGenerics(accumulated, 'cnc', 3, 3);
    expect(consumed).toBe(3);
    expect(accumulated).toHaveLength(1);
    expect(accumulated[0].count).toBe(2);
  });

  it('removes generic entirely when fully consumed', () => {
    const accumulated = [makeGeneric('cnc', 3, 1)];
    const consumed = supersedeGenerics(accumulated, 'cnc', 3, 3);
    expect(consumed).toBe(3);
    expect(accumulated).toHaveLength(0);
  });

  it('removes generic when specific count exceeds generic count', () => {
    const accumulated = [makeGeneric('cnc', 2, 1)];
    const consumed = supersedeGenerics(accumulated, 'cnc', 5, 3);
    expect(consumed).toBe(2);
    expect(accumulated).toHaveLength(0);
  });

  it('consumes from multiple generic entries (most recent first)', () => {
    const accumulated = [
      makeGeneric('cnc', 3, 1),
      makeGeneric('cnc', 2, 5),
    ];
    const consumed = supersedeGenerics(accumulated, 'cnc', 4, 7);
    expect(consumed).toBe(4);
    // Should have consumed 2 from chunk-5 entry (removed) and 2 from chunk-1 entry (1 remaining)
    expect(accumulated).toHaveLength(1);
    expect(accumulated[0].count).toBe(1);
    expect(accumulated[0]._meta.chunkNum).toBe(1);
  });

  it('does not supersede entries outside the proximity window', () => {
    const accumulated = [makeGeneric('cnc', 5, 1)];
    const consumed = supersedeGenerics(accumulated, 'cnc', 3, 1 + SUPERSEDE_WINDOW + 1);
    expect(consumed).toBe(0);
    expect(accumulated[0].count).toBe(5);
  });

  it('supersedes entries at exactly the window boundary', () => {
    const accumulated = [makeGeneric('cnc', 5, 1)];
    const consumed = supersedeGenerics(accumulated, 'cnc', 3, 1 + SUPERSEDE_WINDOW);
    expect(consumed).toBe(3);
    expect(accumulated[0].count).toBe(2);
  });

  it('does not supersede entries from different categories', () => {
    const accumulated = [makeGeneric('paint', 3, 1)];
    const consumed = supersedeGenerics(accumulated, 'cnc', 3, 3);
    expect(consumed).toBe(0);
    expect(accumulated[0].count).toBe(3);
  });

  it('skips non-generic (specific) entries', () => {
    const accumulated = [makeSpecific('Haas', 'VF-2', 'cnc', 3, 1)];
    const consumed = supersedeGenerics(accumulated, 'cnc', 2, 3);
    expect(consumed).toBe(0);
    expect(accumulated[0].count).toBe(3);
  });

  it('returns 0 for null/missing category', () => {
    const accumulated = [makeGeneric('cnc', 5, 1)];
    expect(supersedeGenerics(accumulated, null, 3, 3)).toBe(0);
    expect(supersedeGenerics(accumulated, undefined, 3, 3)).toBe(0);
  });

  it('returns 0 for zero or negative specificCount', () => {
    const accumulated = [makeGeneric('cnc', 5, 1)];
    expect(supersedeGenerics(accumulated, 'cnc', 0, 3)).toBe(0);
    expect(supersedeGenerics(accumulated, 'cnc', -1, 3)).toBe(0);
  });

  it('handles empty accumulated array', () => {
    const accumulated = [];
    expect(supersedeGenerics(accumulated, 'cnc', 3, 3)).toBe(0);
  });

  it('full Kate scenario: 5 generic CNC → 3 Haas + 2 Mazak = 5 total, not 10', () => {
    const accumulated = [makeGeneric('cnc', 5, 1)];

    // Chunk 3: "three Haas VF-2s" arrives
    supersedeGenerics(accumulated, 'cnc', 3, 3);
    expect(accumulated).toHaveLength(1);
    expect(accumulated[0].count).toBe(2);

    accumulated.push(makeSpecific('Haas', 'VF-2', 'cnc', 3, 3));

    // Chunk 4: "two Mazak QTN-200s" arrives
    supersedeGenerics(accumulated, 'cnc', 2, 4);
    const generics = accumulated.filter(a => a._meta.isGeneric);
    expect(generics).toHaveLength(0);

    const mazak = makeSpecific('Mazak', 'QTN-200', 'cnc', 2, 4);
    mazak.cfm_typical = 10;
    mazak._meta.confidence = 'catalog';
    accumulated.push(mazak);

    // Total equipment count should be 5 (3 Haas + 2 Mazak), not 10
    const totalCount = accumulated.reduce((sum, a) => sum + a.count, 0);
    expect(totalCount).toBe(5);
  });
});

// ─── RESET_TRIGGER (verbal equipment list reset) ────────────────────────────

describe('RESET_TRIGGER', () => {
  it('matches "let me start fresh on your equipment"', () => {
    expect(RESET_TRIGGER.test('let me start fresh on your equipment')).toBe(true);
  });

  it('matches "start fresh on equipment"', () => {
    expect(RESET_TRIGGER.test("I want to start fresh on equipment here")).toBe(true);
  });

  it('matches "re-confirm your equipment list"', () => {
    expect(RESET_TRIGGER.test('let me re-confirm your equipment list')).toBe(true);
  });

  it('matches "reconfirm your equipment list" (no hyphen)', () => {
    expect(RESET_TRIGGER.test('let me reconfirm your equipment list')).toBe(true);
  });

  it('matches "recapture your equipment"', () => {
    expect(RESET_TRIGGER.test('I want to recapture your equipment real quick')).toBe(true);
  });

  it('matches "recapture equipment" (no "your")', () => {
    expect(RESET_TRIGGER.test('let me recapture equipment')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(RESET_TRIGGER.test('Let Me Start Fresh On Your Equipment')).toBe(true);
    expect(RESET_TRIGGER.test('RECAPTURE YOUR EQUIPMENT')).toBe(true);
  });

  it('does not match normal equipment conversation', () => {
    expect(RESET_TRIGGER.test('tell me about your equipment')).toBe(false);
    expect(RESET_TRIGGER.test('what equipment do you have')).toBe(false);
    expect(RESET_TRIGGER.test('the equipment is running fine')).toBe(false);
    expect(RESET_TRIGGER.test('we need fresh equipment soon')).toBe(false);
  });

  it('does not match partial phrases', () => {
    expect(RESET_TRIGGER.test('start fresh on your day')).toBe(false);
    expect(RESET_TRIGGER.test('recapture the market')).toBe(false);
    expect(RESET_TRIGGER.test('confirm your list')).toBe(false);
  });
});
