/**
 * equipment-curator.js — Autonomous equipment catalog curation.
 *
 * Three jobs:
 *   1. Resolve unresolved sightings (learn variants or create new entries)
 *   2. Verify stale specs against manufacturer data
 *   3. Report findings via Slack
 *
 * Runs on a schedule (default: daily at 3am) or on-demand via API.
 */

const { pool } = require('../db');
const { findByManufacturerModel, findByVariant, findFuzzy, insertEquipment, logSighting } = require('./equipment-db');
const { lookupEquipment } = require('./equipment-lookup');
const { verifyStaleEntries } = require('./equipment-verifier');
const { sendSlackAlert } = require('./slack');

const BATCH_DELAY = 1500;

// ── Variant Learning ────────────────────────────────────────────────

/**
 * Add a variant alias to an existing catalog entry.
 * Uses Postgres array_append, skips if already present.
 */
async function addVariant(catalogId, variant) {
  try {
    await pool.query(
      `UPDATE equipment_catalog
       SET model_variants = array_append(model_variants, $1),
           updated_at = NOW()
       WHERE id = $2
         AND NOT (model_variants @> ARRAY[$1]::text[])`,
      [variant, catalogId]
    );
    return true;
  } catch (err) {
    console.error(`curator: addVariant failed for id=${catalogId}:`, err.message);
    return false;
  }
}

/**
 * Process a single unresolved sighting.
 *
 * Strategy:
 *   1. Try exact + variant match (may have been resolved by another sighting)
 *   2. Try fuzzy match → if found, add raw_mention as new variant
 *   3. Fall back to equipment-lookup (which includes Claude web search)
 *   4. Mark sighting as resolved either way
 *
 * Returns: { action: 'variant_learned'|'new_entry'|'web_search'|'unresolvable', ... }
 */
async function resolveSighting(sighting) {
  const { id, manufacturer, model, raw_mention } = sighting;

  if (!manufacturer || !model) {
    await markResolved(id, null);
    return { action: 'unresolvable', reason: 'missing manufacturer or model', sightingId: id };
  }

  // Step 1: exact or variant match (cheapest check)
  const exact = await findByManufacturerModel(manufacturer, model);
  if (exact) {
    // Already in catalog — learn the raw_mention as a variant if it's different
    if (raw_mention && raw_mention.toLowerCase() !== model.toLowerCase()) {
      await addVariant(exact.id, raw_mention);
    }
    await markResolved(id, exact.id);
    return { action: 'variant_learned', catalogId: exact.id, manufacturer, model };
  }

  const variant = await findByVariant(manufacturer, model);
  if (variant) {
    if (raw_mention && raw_mention.toLowerCase() !== model.toLowerCase()) {
      await addVariant(variant.id, raw_mention);
    }
    await markResolved(id, variant.id);
    return { action: 'variant_learned', catalogId: variant.id, manufacturer, model };
  }

  // Step 2: fuzzy match — close enough to learn as variant
  const fuzzy = await findFuzzy(manufacturer, model);
  if (fuzzy) {
    // Learn both the extracted model and the raw mention as variants
    await addVariant(fuzzy.id, model);
    if (raw_mention && raw_mention !== model) {
      await addVariant(fuzzy.id, raw_mention);
    }
    await markResolved(id, fuzzy.id);
    return { action: 'variant_learned', catalogId: fuzzy.id, manufacturer, model, fuzzyMatch: fuzzy.model };
  }

  // Step 3: full lookup chain (includes Claude web search, auto-inserts if found)
  const result = await lookupEquipment(manufacturer, model);
  if (result) {
    // Web search created a new entry — learn raw mention as variant
    if (raw_mention && raw_mention !== model) {
      await addVariant(result.id, raw_mention);
    }
    await markResolved(id, result.id);
    return { action: result.confidence === 'unverified' ? 'web_search' : 'new_entry', catalogId: result.id, manufacturer, model };
  }

  // Step 4: truly unresolvable
  await markResolved(id, null);
  return { action: 'unresolvable', reason: 'no match found even via web search', manufacturer, model };
}

async function markResolved(sightingId, catalogMatchId) {
  try {
    await pool.query(
      `UPDATE equipment_sightings
       SET resolved = true, catalog_match_id = COALESCE($1, catalog_match_id)
       WHERE id = $2`,
      [catalogMatchId, sightingId]
    );
  } catch (err) {
    console.error(`curator: markResolved failed for sighting=${sightingId}:`, err.message);
  }
}

// ── Batch Sighting Resolution ───────────────────────────────────────

/**
 * Resolve all unresolved sightings, ordered by frequency.
 * Groups by manufacturer+model to avoid redundant lookups.
 *
 * @param {number} batchSize - Max distinct equipment to process (default: 25)
 */
async function resolveUnresolvedSightings(batchSize = 25) {
  // Get distinct unresolved equipment, ordered by total mention count
  const { rows: groups } = await pool.query(
    `SELECT manufacturer, model,
            MIN(id) AS first_sighting_id,
            MAX(raw_mention) AS sample_raw_mention,
            SUM(COALESCE(count, 1)) AS total_mentions,
            array_agg(id) AS sighting_ids
     FROM equipment_sightings
     WHERE resolved = false AND manufacturer IS NOT NULL AND model IS NOT NULL
     GROUP BY manufacturer, model
     ORDER BY SUM(COALESCE(count, 1)) DESC
     LIMIT $1`,
    [batchSize]
  );

  if (groups.length === 0) return { processed: 0, results: [] };

  const results = [];

  for (const group of groups) {
    // Process the first sighting — this resolves the equipment
    const result = await resolveSighting({
      id: group.first_sighting_id,
      manufacturer: group.manufacturer,
      model: group.model,
      raw_mention: group.sample_raw_mention,
    });

    // Mark all sightings in this group as resolved
    if (result.catalogId) {
      const otherIds = group.sighting_ids.filter(id => id !== group.first_sighting_id);
      if (otherIds.length > 0) {
        await pool.query(
          `UPDATE equipment_sightings
           SET resolved = true, catalog_match_id = $1
           WHERE id = ANY($2)`,
          [result.catalogId, otherIds]
        );
      }
    }

    results.push({
      ...result,
      totalMentions: group.total_mentions,
      sightingsResolved: group.sighting_ids.length,
    });

    await delay(BATCH_DELAY);
  }

  return { processed: results.length, results };
}

// ── Full Curation Run ───────────────────────────────────────────────

/**
 * Run the full curation pipeline:
 *   1. Resolve unresolved sightings
 *   2. Verify stale specs
 *   3. Report to Slack
 *
 * @param {Object} opts
 * @param {number} opts.sightingBatch  - Max sightings to process (default: 25)
 * @param {number} opts.verifyBatch    - Max specs to verify (default: 10)
 * @param {number} opts.staleDays      - Days before a spec is considered stale (default: 30)
 * @param {boolean} opts.autoCorrect   - Apply corrections from trusted sources (default: true)
 * @param {boolean} opts.slackReport   - Send summary to Slack (default: true)
 */
async function runCuration(opts = {}) {
  const {
    sightingBatch = 25,
    verifyBatch = 10,
    staleDays = 30,
    autoCorrect = true,
    slackReport = true,
  } = opts;

  const startTime = Date.now();
  console.log('curator: starting curation run');

  // Phase 1: Resolve sightings
  let sightingResults = { processed: 0, results: [] };
  try {
    sightingResults = await resolveUnresolvedSightings(sightingBatch);
    console.log(`curator: resolved ${sightingResults.processed} equipment groups`);
  } catch (err) {
    console.error('curator: sighting resolution failed:', err.message);
  }

  // Phase 2: Verify stale specs
  let verifyResults = { verified: 0, discrepancies: 0, corrected: 0, results: [] };
  try {
    verifyResults = await verifyStaleEntries({ staleDays, batchSize: verifyBatch, autoCorrect });
    console.log(`curator: verified ${verifyResults.verified} entries, ${verifyResults.discrepancies} discrepancies`);
  } catch (err) {
    console.error('curator: spec verification failed:', err.message);
  }

  // Phase 3: Get health metrics
  const health = await getCatalogHealth();

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const summary = {
    duration: `${duration}s`,
    sightings: {
      processed: sightingResults.processed,
      variantsLearned: sightingResults.results.filter(r => r.action === 'variant_learned').length,
      newEntries: sightingResults.results.filter(r => r.action === 'web_search' || r.action === 'new_entry').length,
      unresolvable: sightingResults.results.filter(r => r.action === 'unresolvable').length,
    },
    verification: {
      verified: verifyResults.verified,
      discrepancies: verifyResults.discrepancies,
      corrected: verifyResults.corrected,
    },
    health,
    details: {
      sightings: sightingResults.results,
      verification: verifyResults.results,
    },
  };

  // Phase 4: Slack report
  if (slackReport) {
    await sendCurationReport(summary);
  }

  // Phase 5: Log to curation_log table
  await logCurationRun(summary);

  console.log(`curator: run complete in ${duration}s`);
  return summary;
}

// ── Catalog Health Metrics ──────────────────────────────────────────

async function getCatalogHealth() {
  try {
    const [total, confidence, details, sightings, stale] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM equipment_catalog'),
      pool.query(`SELECT confidence, COUNT(*)::int AS count FROM equipment_catalog GROUP BY confidence ORDER BY confidence`),
      pool.query(`SELECT COUNT(*)::int AS with_details FROM equipment_details`),
      pool.query(`SELECT COUNT(*)::int AS unresolved FROM equipment_sightings WHERE resolved = false`),
      pool.query(`SELECT COUNT(*)::int AS stale FROM equipment_catalog WHERE last_verified_at IS NULL OR last_verified_at < NOW() - INTERVAL '30 days'`),
    ]);

    return {
      totalEntries: total.rows[0].count,
      byConfidence: Object.fromEntries(confidence.rows.map(r => [r.confidence, r.count])),
      withDetails: details.rows[0].with_details,
      unresolvedSightings: sightings.rows[0].unresolved,
      staleEntries: stale.rows[0].stale,
    };
  } catch (err) {
    console.error('curator: health check failed:', err.message);
    return null;
  }
}

// ── Curation Log ────────────────────────────────────────────────────

async function logCurationRun(summary) {
  try {
    await pool.query(
      `INSERT INTO equipment_curation_log (run_summary) VALUES ($1)`,
      [JSON.stringify(summary)]
    );
  } catch (err) {
    console.error('curator: failed to log curation run:', err.message);
  }
}

// ── Slack Reporting ─────────────────────────────────────────────────

async function sendCurationReport(summary) {
  const s = summary.sightings;
  const v = summary.verification;
  const h = summary.health;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':gear: Equipment Catalog Curation Report' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Duration:* ${summary.duration}` },
        { type: 'mrkdwn', text: `*Total Entries:* ${h?.totalEntries || '?'}` },
      ],
    },
  ];

  if (s.processed > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Sightings Resolved:* ${s.processed}\n` +
          `• Variants learned: ${s.variantsLearned}\n` +
          `• New entries (web search): ${s.newEntries}\n` +
          `• Unresolvable: ${s.unresolvable}`,
      },
    });
  }

  if (v.verified > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Spec Verification:* ${v.verified} checked\n` +
          `• Discrepancies: ${v.discrepancies}\n` +
          `• Auto-corrected: ${v.corrected}`,
      },
    });
  }

  if (h) {
    const confidenceStr = Object.entries(h.byConfidence)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Health:* ${h.withDetails} with sales details · ` +
          `${h.unresolvedSightings} unresolved sightings · ` +
          `${h.staleEntries} stale specs\n` +
          `*Confidence:* ${confidenceStr}`,
      },
    });
  }

  // Add discrepancy details if any — flag trusted vs untrusted sources
  const discrepancies = summary.details?.verification?.filter(r => r.status === 'discrepancy') || [];
  if (discrepancies.length > 0) {
    const lines = discrepancies.slice(0, 5).map(d => {
      const trust = d.sourceTrusted ? ':white_check_mark: auto-corrected' : ':warning: untrusted source — needs manual review';
      return `• *${d.manufacturer} ${d.model}*: ${d.discrepancies.join('; ')} (${trust})`;
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Discrepancies Found:*\n${lines.join('\n')}` },
    });
  }

  await sendSlackAlert({ blocks });
}

// ── Scheduler ───────────────────────────────────────────────────────

let schedulerTimer = null;

/**
 * Start the curation scheduler.
 * Default: runs at 3:00 AM local time daily.
 */
function startScheduler(opts = {}) {
  if (schedulerTimer) return; // already running

  const {
    hourUTC = 10,  // 3am MST = 10:00 UTC
    sightingBatch = 25,
    verifyBatch = 10,
    staleDays = 30,
    autoCorrect = true,
  } = opts;

  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUTC, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const msUntil = next - now;
    console.log(`curator: next run scheduled for ${next.toISOString()} (${(msUntil / 3600000).toFixed(1)}h)`);

    schedulerTimer = setTimeout(async () => {
      try {
        await runCuration({ sightingBatch, verifyBatch, staleDays, autoCorrect });
      } catch (err) {
        console.error('curator: scheduled run failed:', err.message);
      }
      scheduleNext();
    }, msUntil);
    schedulerTimer.unref(); // don't prevent process exit
  }

  scheduleNext();
}

function stopScheduler() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
    console.log('curator: scheduler stopped');
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  addVariant,
  resolveSighting,
  resolveUnresolvedSightings,
  runCuration,
  getCatalogHealth,
  startScheduler,
  stopScheduler,
};
