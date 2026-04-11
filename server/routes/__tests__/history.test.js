// Flush microtask queue so fire-and-forget .then()/.catch() chains settle.
// Works because history.js chains have no intermediate awaits. If that changes,
// increase the flush count here — single point of fix.
const flushFireAndForget = () => new Promise((r) => setImmediate(r));

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
  formatCallAlert: jest.fn().mockReturnValue({ text: 'mock alert' }),
}));
jest.mock('../../lib/hubspot', () => ({
  addNoteToContact: jest.fn().mockResolvedValue({}),
  getContact: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/interaction-sync', () => ({
  syncInteraction: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../lib/format', () => ({
  formatDuration: jest.fn().mockReturnValue('5m 42s'),
}));
jest.mock('../../lib/customer-lookup', () => ({
  lookupCustomer: jest.fn().mockResolvedValue(null),
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { sendSlackAlert, formatCallAlert } = require('../../lib/slack');
const { addNoteToContact } = require('../../lib/hubspot');
const { syncInteraction } = require('../../lib/interaction-sync');
const { lookupCustomer } = require('../../lib/customer-lookup');

const API_KEY = 'test-api-key';

const SAMPLE_CALL = {
  id: 1,
  created_at: '2026-03-25T10:00:00Z',
  conference_name: 'nucleus-call-abc',
  caller_identity: 'ryann',
  lead_phone: '+16025551234',
  lead_name: 'Jane Doe',
  lead_company: 'Acme Corp',
  hubspot_contact_id: '101',
  direction: 'outbound',
  status: 'completed',
  duration_seconds: 342,
  disposition: null,
  qualification: null,
  products_discussed: null,
  notes: null,
  recording_url: null,
  recording_duration: null,
  fireflies_uploaded: false,
  ci_summary: null,
  sentiment: null,
  competitive_intel: null,
  ci_products: null,
};

function mockSession(identity, role = 'caller') {
  jwt.verify.mockReturnValue({ identity, role, email: `${identity}@joruva.com` });
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/history', require('../history'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

/* ───────────── GET /api/history ───────────── */

describe('GET /api/history', () => {
  test('returns 401 without session cookie', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app).get('/api/history').expect(401);
  });

  test('returns 401 with API key (sessionAuth only)', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app)
      .get('/api/history')
      .set('x-api-key', API_KEY)
      .expect(401);
  });

  test('returns calls and total count for authenticated caller', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

    const res = await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test('caller role forced to own calls only (ignores caller param)', async () => {
    mockSession('ryann', 'caller');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?caller=kate')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).toContain('ryann');
    expect(dataParams).not.toContain('kate');
  });

  test('admin can see all calls (no caller filter applied)', async () => {
    mockSession('tom', 'admin');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).not.toContain('tom');
  });

  test('admin can filter by specific caller', async () => {
    mockSession('tom', 'admin');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?caller=ryann')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toContain('ryann');
  });

  test('FTS search with q param triggers tsvector query', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?q=compressor')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('to_tsvector');
    expect(dataQuery).toContain('plainto_tsquery');
    expect(pool.query.mock.calls[0][1]).toContain('compressor');
  });

  test('disposition filter', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?disposition=connected')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toContain('connected');
  });

  test('qualification filter', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?qualification=hot')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('qualification');
    expect(pool.query.mock.calls[0][1]).toContain('hot');
  });

  test('date range from/to filters', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?from=2026-04-01T00:00:00Z&to=2026-04-10T23:59:59Z')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('created_at >=');
    expect(dataQuery).toContain('created_at <=');
  });

  test('hasSummary=true triggers EXISTS subquery', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?hasSummary=true')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('ai_summary IS NOT NULL');
    expect(dataQuery).toContain('EXISTS');
  });

  test('data query uses LATERAL JOIN on customer_interactions', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('LEFT JOIN LATERAL');
    expect(dataQuery).toContain('customer_interactions');
  });

  test('count query does NOT use LATERAL JOIN', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const countQuery = pool.query.mock.calls[1][0];
    expect(countQuery).toContain('COUNT(*)');
    expect(countQuery).not.toContain('LEFT JOIN LATERAL');
  });

  test('clamps limit to 1–200 range', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?limit=999')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toContain(200);
  });

  test('pagination with limit + offset', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?limit=10&offset=20')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain(10);
    expect(params).toContain(20);
  });

  test('returns 500 on DB error', async () => {
    mockSession('ryann');
    pool.query.mockRejectedValueOnce(new Error('db error'));

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(500);
  });
});

/* ───────────── GET /api/history/:id ───────────── */

describe('GET /api/history/:id', () => {
  test('returns 401 without session', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app).get('/api/history/1').expect(401);
  });

  test('returns 400 for non-numeric id', async () => {
    mockSession('ryann');
    await request(app)
      .get('/api/history/abc')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(400);
  });

  test('returns 404 when call not found', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/999')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);
  });

  test('returns call detail with LATERAL JOIN for own call', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 });

    const res = await request(app)
      .get('/api/history/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.id).toBe(1);
    const query = pool.query.mock.calls[0][0];
    expect(query).toContain('LEFT JOIN LATERAL');
  });

  test('non-admin cannot access other callers detail', async () => {
    mockSession('kate', 'caller');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain('kate');
  });

  test('admin can access any call', async () => {
    mockSession('tom', 'admin');
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 });

    await request(app)
      .get('/api/history/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toEqual([1]);
  });
});

/* ───────────── GET /api/history/:id/timeline ───────────── */

describe('GET /api/history/:id/timeline', () => {
  test('returns 401 without session', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app).get('/api/history/1/timeline').expect(401);
  });

  test('returns 404 if parent call not found', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/999/timeline')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);
  });

  test('non-admin cannot access other callers timeline (404 gate)', async () => {
    mockSession('kate', 'caller');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/1/timeline')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);

    // Parent call query should filter by caller_identity
    const params = pool.query.mock.calls[0][1];
    expect(params).toContain('kate');
    // lookupCustomer should NOT have been called because parent gate failed
    expect(lookupCustomer).not.toHaveBeenCalled();
  });

  test('returns interactions for owned call', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({
      rows: [{
        lead_phone: '+16025551234',
        lead_email: null,
        hubspot_contact_id: '101',
        lead_company: 'Acme',
        lead_name: 'Jane',
        conference_name: 'nucleus-call-abc',
      }],
      rowCount: 1,
    });
    lookupCustomer.mockResolvedValueOnce({
      interactions: [
        { sessionId: 'npc_other', channel: 'voice', summary: 'Prior call' },
        { sessionId: 'npc_nucleus-call-abc', channel: 'voice', summary: 'This call' },
      ],
    });

    const res = await request(app)
      .get('/api/history/1/timeline')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    // Current call's own session_id should be excluded
    expect(res.body.interactions).toHaveLength(1);
    expect(res.body.interactions[0].sessionId).toBe('npc_other');
  });
});

/* ───────────── POST /api/history/:id/disposition ───────────── */

describe('POST /api/history/:id/disposition', () => {
  test('returns 400 for non-numeric id', async () => {
    await request(app)
      .post('/api/history/abc/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(400);
  });

  test('returns 400 when disposition is missing', async () => {
    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ notes: 'good call' })
      .expect(400);
  });

  test('returns 404 when call not found', async () => {
    // Enriched re-fetch returns empty, initial UPDATE returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .post('/api/history/999/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(404);
  });

  test('non-admin session user cannot modify other callers call (403)', async () => {
    mockSession('kate', 'caller');
    // Ownership check returns tom's call
    pool.query.mockResolvedValueOnce({
      rows: [{ caller_identity: 'tom' }],
      rowCount: 1,
    });

    await request(app)
      .post('/api/history/1/disposition')
      .set('Cookie', 'nucleus_session=fake-token')
      .set('X-Requested-With', 'fetch')
      .send({ disposition: 'connected' })
      .expect(403);
  });

  test('admin session user can modify any call', async () => {
    mockSession('tom', 'admin');
    // Ownership check SKIPPED for admin. Jumps straight to UPDATE.
    const updated = { ...SAMPLE_CALL, disposition: 'connected', caller_identity: 'ryann' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }); // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('Cookie', 'nucleus_session=fake-token')
      .set('X-Requested-With', 'fetch')
      .send({ disposition: 'connected' })
      .expect(200);
  });

  test('API key caller skips ownership check (trusted automation)', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }); // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    // Should have called UPDATE first (no ownership SELECT)
    expect(pool.query.mock.calls[0][0]).toContain('UPDATE');
  });

  test('saves disposition and returns enriched call', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected', qualification: null };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })   // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });  // enriched re-fetch

    const res = await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    expect(res.body.disposition).toBe('connected');
  });

  test('enriched response query uses LATERAL JOIN', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    // Second query is the enriched re-fetch — should use LATERAL JOIN
    const enrichedQuery = pool.query.mock.calls[1][0];
    expect(enrichedQuery).toContain('LEFT JOIN LATERAL');
  });

  test('sends Slack alert for hot leads', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'qualified', qualification: 'hot' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // slack flag UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });   // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'qualified', qualification: 'hot', notes: 'ready to buy' })
      .expect(200);

    await flushFireAndForget();

    expect(formatCallAlert).toHaveBeenCalledWith(
      expect.objectContaining({ qualification: 'hot' })
    );
    expect(sendSlackAlert).toHaveBeenCalled();
  });

  test('does NOT send Slack alert for cold leads', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'not_interested', qualification: 'cold' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'not_interested', qualification: 'cold' })
      .expect(200);

    await flushFireAndForget();

    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  test('syncs note to HubSpot when contact id present', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // hubspot_synced UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });  // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected', notes: 'good chat' })
      .expect(200);

    await flushFireAndForget();

    expect(addNoteToContact).toHaveBeenCalledWith(
      '101',
      expect.stringContaining('Outbound call by ryann')
    );
  });

  test('does NOT sync to HubSpot when no contact id', async () => {
    const updated = { ...SAMPLE_CALL, hubspot_contact_id: null, disposition: 'voicemail' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'voicemail' })
      .expect(200);

    await flushFireAndForget();

    expect(addNoteToContact).not.toHaveBeenCalled();
  });

  test('syncs interaction to customer_interactions', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    await flushFireAndForget();

    expect(syncInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'voice',
        direction: 'outbound',
        phone: '+16025551234',
      })
    );
  });

  test('maps hot qualification to qualified_hot disposition in sync', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'qualified', qualification: 'hot' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // slack flag
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });   // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'qualified', qualification: 'hot' })
      .expect(200);

    await flushFireAndForget();

    expect(syncInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'qualified_hot',
        qualification: { stage: 'hot', score: 90 },
      })
    );
  });

  test('returns 500 on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(500);
  });
});
