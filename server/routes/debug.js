/**
 * routes/debug.js — Admin-only debug API endpoints.
 *
 * Mounted at /api/debug with apiKeyAuth + rbac('admin') in index.js.
 * Provides queryable access to debug_events, integration health,
 * active WebSocket connections, and sweep history.
 */

const { Router } = require('express');
const { pool } = require('../db');
const { getAll: getHealthAll } = require('../lib/health-tracker');
const { getConnectionStats } = require('../lib/live-analysis');

const router = Router();

// GET /api/debug/events — query the debug event log
router.get('/events', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const conditions = [];
  const params = [];
  let idx = 1;

  if (req.query.category) {
    conditions.push(`category = $${idx++}`);
    params.push(req.query.category);
  }
  if (req.query.level) {
    conditions.push(`level = $${idx++}`);
    params.push(req.query.level);
  }
  if (req.query.callId) {
    conditions.push(`call_id = $${idx++}`);
    params.push(req.query.callId);
  }
  if (req.query.caller) {
    conditions.push(`caller_identity = $${idx++}`);
    params.push(req.query.caller);
  }
  if (req.query.since) {
    const d = new Date(req.query.since);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid since timestamp' });
    conditions.push(`ts >= $${idx++}`);
    params.push(d.toISOString());
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  try {
    const { rows } = await pool.query(
      `SELECT id, ts, category, source, level, summary, detail, call_id, caller_identity
       FROM debug_events ${where}
       ORDER BY ts DESC LIMIT $${idx}`,
      params,
    );
    // Strip the LIMIT param (last element) — COUNT needs same WHERE but no LIMIT
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM debug_events ${where}`,
      params.slice(0, -1),
    );
    res.json({ events: rows, total: count });
  } catch (err) {
    console.error('debug events query failed:', err.message);
    res.status(500).json({ error: 'Failed to query events' });
  }
});

// GET /api/debug/health — integration health + DB ping
router.get('/health', async (req, res) => {
  const integrations = getHealthAll();
  let dbStatus = 'ok';
  let dbLatencyMs = 0;

  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    dbLatencyMs = Date.now() - start;
  } catch {
    dbStatus = 'error';
    dbLatencyMs = Date.now() - start;
  }

  res.json({
    db: { status: dbStatus, latencyMs: dbLatencyMs },
    integrations,
    uptime_seconds: Math.round(process.uptime()),
  });
});

// GET /api/debug/connections — active WebSocket subscriptions
router.get('/connections', (_req, res) => {
  const stats = getConnectionStats();
  res.json(stats);
});

// GET /api/debug/sweep — last 20 sweep events
router.get('/sweep', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ts, source, level, summary, detail
       FROM debug_events
       WHERE category = 'sweep'
       ORDER BY ts DESC LIMIT 20`,
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('debug sweep query failed:', err.message);
    res.status(500).json({ error: 'Failed to query sweep events' });
  }
});

module.exports = router;
