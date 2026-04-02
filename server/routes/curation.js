/**
 * curation.js — Admin API for equipment catalog curation.
 *
 * All routes require apiKeyAuth (registered in index.js).
 */

const { Router } = require('express');
const { pool } = require('../db');
const { runCuration, getCatalogHealth, resolveUnresolvedSightings } = require('../lib/equipment-curator');
const { verifyStaleEntries } = require('../lib/equipment-verifier');

const router = Router();

// Track running jobs — timestamp-based guard prevents permanent lockout
// if the process crashes mid-run. Max 30 minutes before auto-clearing.
let curationStartedAt = null;
const MAX_CURATION_MS = 30 * 60 * 1000;

function isCurationRunning() {
  if (!curationStartedAt) return false;
  if (Date.now() - curationStartedAt > MAX_CURATION_MS) {
    console.warn('curation: stale lock detected — clearing');
    curationStartedAt = null;
    return false;
  }
  return true;
}

// POST /api/curation/run — trigger a full curation run
router.post('/run', async (req, res) => {
  if (isCurationRunning()) {
    return res.status(409).json({
      error: 'Curation already in progress',
      startedAt: new Date(curationStartedAt).toISOString(),
    });
  }

  const body = req.body || {};
  const sightingBatch = Math.min(Math.max(parseInt(body.sightingBatch, 10) || 25, 1), 100);
  const verifyBatch = Math.min(Math.max(parseInt(body.verifyBatch, 10) || 10, 1), 50);
  const staleDays = Math.min(Math.max(parseInt(body.staleDays, 10) || 30, 1), 365);
  const autoCorrect = body.autoCorrect !== false; // default true

  curationStartedAt = Date.now();
  res.json({ status: 'started', message: 'Curation run started — results will post to Slack' });

  // Run async — don't block the response
  try {
    await runCuration({ sightingBatch, verifyBatch, staleDays, autoCorrect, slackReport: true });
  } catch (err) {
    console.error('curation run error:', err.message);
  } finally {
    curationStartedAt = null;
  }
});

// GET /api/curation/status — check if curation is running
router.get('/status', (req, res) => {
  const running = isCurationRunning();
  res.json({
    running,
    startedAt: curationStartedAt ? new Date(curationStartedAt).toISOString() : null,
    elapsedMs: curationStartedAt ? Date.now() - curationStartedAt : null,
  });
});

// POST /api/curation/resolve-sightings — resolve unresolved sightings only
router.post('/resolve-sightings', async (req, res) => {
  const batchSize = Math.min(parseInt(req.body?.batchSize, 10) || 25, 100);

  try {
    const results = await resolveUnresolvedSightings(batchSize);
    res.json(results);
  } catch (err) {
    console.error('resolve-sightings error:', err.message);
    res.status(500).json({ error: 'Resolution failed' });
  }
});

// POST /api/curation/verify — verify stale specs only
router.post('/verify', async (req, res) => {
  const {
    batchSize = 10,
    staleDays = 30,
    autoCorrect = true,
  } = req.body || {};

  try {
    const results = await verifyStaleEntries({
      staleDays,
      batchSize: Math.min(batchSize, 50),
      autoCorrect,
    });
    res.json(results);
  } catch (err) {
    console.error('verify error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// GET /api/curation/health — catalog health metrics
router.get('/health', async (req, res) => {
  try {
    const health = await getCatalogHealth();
    res.json(health);
  } catch (err) {
    console.error('health error:', err.message);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// GET /api/curation/log — recent curation run history
router.get('/log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  try {
    const { rows } = await pool.query(
      `SELECT id, run_summary, created_at
       FROM equipment_curation_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ results: rows, count: rows.length });
  } catch (err) {
    if (err.code === '42P01') {
      return res.json({ results: [], count: 0 });
    }
    console.error('curation log error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

module.exports = router;
