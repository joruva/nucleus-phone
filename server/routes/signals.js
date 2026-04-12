/**
 * Signal data routes — all routes proxy to multichannel's ABM API.
 * Static routes (/pipeline, /callbacks) MUST come before parameterized routes (/:domain).
 */

const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const { pool } = require('../db');
const { runBatchEnrichment, getJobStatus, checkApolloBudget, claimEnrichmentSlot } = require('../lib/signal-enrichment');

// Every route in this file is admin-only. Signals expose ABM pipeline
// internals (tiers, DOD flags, contract totals) and credit-spending enrichment
// jobs — external callers and internal callers have no business here.
router.use(apiKeyAuth, rbac('admin'));

const MC_BASE = process.env.MULTICHANNEL_API_URL || 'https://joruva-multichannel.onrender.com';
const MC_API_KEY = process.env.MC_API_KEY || '';

// GET /api/signals/pipeline — batch pipeline view for team work queue
// Proxies to multichannel's /admin/abm/accounts which now returns signal fields
// (signal_tier, signal_score, cert_expiry_date, contract_total, source_count, dod_flag).
// MUST be before /:domain or Express will match "pipeline" as a domain param.
router.get('/pipeline', async (req, res) => {
  try {
    const { signal_tier, geo_state, limit = '100', offset = '0' } = req.query;
    const params = new URLSearchParams();
    if (signal_tier) params.set('signal_tier', signal_tier);
    if (geo_state) params.set('geo_state', geo_state);
    params.set('limit', String(Math.max(1, Math.min(parseInt(limit, 10) || 100, 500))));
    params.set('offset', String(Math.max(0, parseInt(offset, 10) || 0)));

    const url = `${MC_BASE}/admin/abm/accounts?${params}`;
    const resp = await fetch(url, {
      headers: MC_API_KEY ? { 'x-api-key': MC_API_KEY } : {},
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return res.status(resp.status).json({ error: 'Pipeline fetch failed', companies: [] });
    const data = await resp.json();
    res.json({ companies: data.accounts || [] });
  } catch (err) {
    console.error('pipeline proxy error:', err.message);
    res.status(500).json({ error: 'Pipeline fetch failed', companies: [] });
  }
});

// GET /api/signals/callbacks — pending phone callbacks from multichannel engagement processor
// TODO: Replace polling with WebSocket push when callback volume justifies it
router.get('/callbacks', async (req, res) => {
  try {
    const url = `${MC_BASE}/health/callbacks`;
    const resp = await fetch(url, {
      headers: MC_API_KEY ? { 'x-api-key': MC_API_KEY } : {},
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return res.json({ callbacks: [] });
    const data = await resp.json();
    res.json({ callbacks: data.data || [] });
  } catch (err) {
    // Graceful degradation — multichannel down means empty callbacks, not an error
    console.warn('callbacks proxy failed:', err.message);
    res.json({ callbacks: [] });
  }
});

// POST /api/signals/enrich-batch — kick off batch Apollo enrichment for SPEAR+TARGETED companies
// Fire-and-forget: returns job ID immediately, enrichment runs in background.
// Check progress via GET /api/signals/enrich-batch/:jobId
router.post('/enrich-batch', apiKeyAuth, async (req, res) => {
  if (!process.env.APOLLO_API_KEY) {
    return res.status(503).json({ error: 'APOLLO_API_KEY not configured' });
  }

  const { tiers = ['spear', 'targeted'], resumeFrom, jobId } = req.body || {};

  // Validate tiers
  const validTiers = ['spear', 'targeted', 'awareness'];
  if (!Array.isArray(tiers) || tiers.some(t => !validTiers.includes(t))) {
    return res.status(400).json({ error: `tiers must be array of: ${validTiers.join(', ')}` });
  }

  // Check budget before starting
  try {
    const budget = await checkApolloBudget();
    if (!budget.allowed) {
      return res.json({
        status: 'paused',
        message: `Daily budget exhausted (${budget.consumed}/400). Try again tomorrow.`,
        budget,
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Budget check failed: ' + err.message });
  }

  try {
    const activeJobId = jobId || await claimEnrichmentSlot(tiers);

    res.json({ jobId: activeJobId, status: 'running', message: 'Enrichment started. Poll GET /api/signals/enrich-batch/' + activeJobId });

    runBatchEnrichment({ tiers, resumeFrom, jobId: activeJobId }).catch(err => {
      console.error('Background enrichment failed:', err.message);
    });
  } catch (err) {
    if (err.code === 'CONCURRENT_JOB') {
      return res.status(409).json({ error: err.message, activeJobId: err.activeJobId });
    }
    console.error('Failed to start enrichment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signals/enrich-batch/:jobId — check batch enrichment job progress
router.get('/enrich-batch/:jobId', apiKeyAuth, async (req, res) => {
  try {
    const job = await getJobStatus(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signals/:domain — proxy to multichannel's /admin/abm/account/:domain/signals
router.get('/:domain', async (req, res) => {
  const { domain } = req.params;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  try {
    const url = `${MC_BASE}/admin/abm/account/${encodeURIComponent(domain)}/signals`;
    const resp = await fetch(url, {
      headers: MC_API_KEY ? { 'x-api-key': MC_API_KEY } : {},
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      if (resp.status === 404) return res.json({ account: null, signal_metadata: null, recent_signals: [] });
      return res.status(resp.status).json({ error: `multichannel API returned ${resp.status}` });
    }

    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('signals proxy error:', err.message);
    res.json({ account: null, signal_metadata: null, recent_signals: [] });
  }
});

module.exports = router;
