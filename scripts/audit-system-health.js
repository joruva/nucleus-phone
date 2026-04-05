#!/usr/bin/env node
/**
 * scripts/audit-system-health.js
 *
 * Exhaustive system health audit across nucleus-phone, UCIL, and shared tables.
 * Identifies loose ends, broken data flows, orphaned data, and incomplete features.
 *
 * Usage: node scripts/audit-system-health.js
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const issues = [];
function flag(severity, system, title, detail) {
  issues.push({ severity, system, title, detail });
}

async function q(sql, params) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (err) {
    return null; // table doesn't exist or query error
  }
}

async function tableExists(name) {
  const rows = await q(`SELECT to_regclass($1) AS t`, [name]);
  return rows?.[0]?.t !== null;
}

// ── 1. Table existence checks ──────────────────────────────────────────
async function auditTables() {
  console.log('  Checking table existence...');
  const required = [
    ['nucleus_phone_calls', 'nucleus-phone'],
    ['customer_interactions', 'UCIL (shared)'],
    ['ucil_voice_calls', 'UCIL'],
    ['ucil_voice_leads', 'UCIL'],
    ['ucil_sync_state', 'nucleus-phone'],
    ['ucil_agent_stats', 'nucleus-phone'],
    ['v35_signal_metadata', 'v35 pipeline'],
    ['v35_lead_reservoir', 'v35 pipeline'],
    ['v35_pb_contacts', 'v35 pipeline'],
    ['v35_discovery_queue', 'v35 pipeline'],
    ['v35_webhook_events', 'v35 pipeline'],
    ['v35_credit_daily_ledger', 'v35 pipeline'],
    ['qa_results', 'v35 pipeline'],
    ['quote_requests', 'nucleus-phone'],
    ['sim_call_scores', 'nucleus-phone'],
    ['signal_enrichment_jobs', 'nucleus-phone'],
    ['msal_token_cache', 'nucleus-phone'],
    ['equipment_catalog', 'nucleus-phone'],
  ];

  for (const [table, owner] of required) {
    if (!(await tableExists(table))) {
      flag('CRITICAL', owner, `Missing table: ${table}`, `Table required by code but doesn't exist in DB`);
    }
  }
}

// ── 2. Signal pipeline completeness ────────────────────────────────────
async function auditSignalPipeline() {
  console.log('  Checking signal pipeline...');

  // Companies with resolved domains but no contacts
  const noContacts = await q(`
    SELECT count(*) as cnt FROM v35_signal_metadata sm
    WHERE sm.signal_tier IN ('spear', 'targeted')
      AND sm.domain NOT LIKE '%.signal-pending'
      AND NOT EXISTS (SELECT 1 FROM v35_pb_contacts pb WHERE pb.domain = sm.domain)
  `);
  if (noContacts?.[0]?.cnt > 0) {
    flag('HIGH', 'signal-pipeline', `${noContacts[0].cnt} signal companies have domains but no contacts`,
      'Enrichment job needs to run (Apollo people search) to populate contacts');
  }

  // Still-pending domains
  const pending = await q(`
    SELECT count(*) as cnt FROM v35_signal_metadata
    WHERE domain LIKE '%.signal-pending' AND signal_tier IN ('spear', 'targeted')
  `);
  if (pending?.[0]?.cnt > 0) {
    flag('MEDIUM', 'signal-pipeline', `${pending[0].cnt} signal companies still have .signal-pending domains`,
      'Run scripts/resolve-signal-domains.js to resolve remaining placeholder domains');
  }

  // Contacts with NULL domain (old PB imports)
  const nullDomain = await q(`
    SELECT count(*) as cnt FROM v35_pb_contacts WHERE domain IS NULL
  `);
  if (nullDomain?.[0]?.cnt > 0) {
    flag('LOW', 'signal-pipeline', `${nullDomain[0].cnt} PB contacts have NULL domain`,
      'Old PhantomBuster imports lack domain field — cannot be linked to signal companies');
  }
}

// ── 3. Credit budget tracking ──────────────────────────────────────────
async function auditCreditTracking() {
  console.log('  Checking credit tracking...');

  // Check for dual budget systems
  const syncState = await q(`
    SELECT sync_key, metadata FROM ucil_sync_state
    WHERE sync_key IN ('apollo_daily', 'dropcontact_daily')
  `);
  const ledger = await q(`
    SELECT service, consumed, remaining FROM v35_credit_daily_ledger
    WHERE ledger_date = CURRENT_DATE
  `);

  if (syncState?.length > 0 && ledger?.length > 0) {
    flag('HIGH', 'credit-tracking', 'Dual credit tracking detected',
      'identity-resolver.js uses ucil_sync_state, signal-enrichment.js uses v35_credit_daily_ledger. ' +
      'These are separate counters for the same Apollo budget — risk of overspend.');
  }
}

// ── 4. Fireflies sync health ──────────────────────────────────────────
async function auditFirefliesSync() {
  console.log('  Checking Fireflies sync...');

  const cursor = await q(`
    SELECT last_sync_at FROM ucil_sync_state WHERE sync_key = 'fireflies'
  `);
  if (!cursor?.length) {
    flag('MEDIUM', 'fireflies', 'No Fireflies sync cursor found',
      'Fireflies sync has never run or cursor was lost. First run will seed from 7 days ago.');
  } else {
    const lastSync = new Date(cursor[0].last_sync_at);
    const hoursSinceSync = (Date.now() - lastSync.getTime()) / 3600000;
    if (hoursSinceSync > 24) {
      flag('MEDIUM', 'fireflies', `Fireflies sync stale: ${Math.round(hoursSinceSync)}h since last sync`,
        `Last sync: ${lastSync.toISOString()}. Expected every 30 min via n8n.`);
    }
  }

  // Check for ff_ sessions in customer_interactions
  const ffSessions = await q(`
    SELECT count(*) as cnt FROM customer_interactions WHERE session_id LIKE 'ff_%'
  `);
  if (ffSessions?.[0]?.cnt === '0') {
    flag('LOW', 'fireflies', 'No Fireflies-synced interactions found',
      'customer_interactions has no ff_ sessions — Fireflies sync may not be running');
  }
}

// ── 5. UCIL voice pipeline ─────────────────────────────────────────────
async function auditUCILVoice() {
  console.log('  Checking UCIL voice pipeline...');

  // Stuck leads
  const stuckLeads = await q(`
    SELECT count(*) as cnt FROM ucil_voice_leads
    WHERE sync_status = 'failed' AND sync_attempts >= 3
  `);
  if (stuckLeads?.[0]?.cnt > 0) {
    flag('MEDIUM', 'UCIL', `${stuckLeads[0].cnt} voice leads permanently failed sync`,
      'These leads exhausted 3 retry attempts. Check HubSpot/M365 connectivity.');
  }

  // Pending syncs
  const pendingSyncs = await q(`
    SELECT count(*) as cnt FROM ucil_voice_leads
    WHERE sync_status IN ('pending', 'syncing')
      AND created_at < NOW() - INTERVAL '1 hour'
  `);
  if (pendingSyncs?.[0]?.cnt > 0) {
    flag('HIGH', 'UCIL', `${pendingSyncs[0].cnt} voice leads stuck in pending/syncing for >1 hour`,
      'Sync worker may be down or failing silently');
  }

  // Transfers not completed
  const stuckTransfers = await q(`
    SELECT count(*) as cnt FROM ucil_voice_calls
    WHERE transfer_status = 'initiated'
      AND transfer_initiated_at < NOW() - INTERVAL '30 minutes'
  `);
  if (stuckTransfers?.[0]?.cnt > 0) {
    flag('MEDIUM', 'UCIL', `${stuckTransfers[0].cnt} transfers stuck in 'initiated' state`,
      'Vapi may not have sent the post-call webhook to update transfer outcome');
  }
}

// ── 6. Nucleus phone calls health ──────────────────────────────────────
async function auditNucleusCalls() {
  console.log('  Checking nucleus phone calls...');

  // Stuck calls
  const stuck = await q(`
    SELECT count(*) as cnt FROM nucleus_phone_calls
    WHERE status IN ('connecting', 'in-progress')
      AND created_at < NOW() - INTERVAL '30 minutes'
  `);
  if (stuck?.[0]?.cnt > 0) {
    flag('HIGH', 'nucleus-phone', `${stuck[0].cnt} calls stuck in connecting/in-progress`,
      'Stale sweep should clean these — check if sweep is running');
  }

  // Calls without AI summary
  const noSummary = await q(`
    SELECT count(*) as cnt FROM nucleus_phone_calls
    WHERE status = 'completed' AND transcript IS NOT NULL
      AND LENGTH(transcript) > 50 AND ai_summarized = FALSE
  `);
  if (noSummary?.[0]?.cnt > 0) {
    flag('LOW', 'nucleus-phone', `${noSummary[0].cnt} completed calls with transcript but no AI summary`,
      'Post-call summarization (transcription-stopped webhook) may have failed');
  }

  // Calls not synced to HubSpot
  const unsynced = await q(`
    SELECT count(*) as cnt FROM nucleus_phone_calls
    WHERE status = 'completed' AND hubspot_contact_id IS NOT NULL
      AND hubspot_synced = FALSE AND disposition IS NOT NULL
  `);
  if (unsynced?.[0]?.cnt > 0) {
    flag('MEDIUM', 'nucleus-phone', `${unsynced[0].cnt} completed calls not synced to HubSpot`,
      'HubSpot note creation (fire-and-forget in history.js) may have failed silently');
  }

  // Sim scores stuck scoring
  const stuckSims = await q(`
    SELECT count(*) as cnt FROM sim_call_scores
    WHERE status IN ('in-progress', 'scoring')
      AND created_at < NOW() - INTERVAL '15 minutes'
  `);
  if (stuckSims?.[0]?.cnt > 0) {
    flag('LOW', 'nucleus-phone', `${stuckSims[0].cnt} practice calls stuck in scoring`,
      'Stale sweep should clean these to score-failed status');
  }
}

// ── 7. Enrichment job status ───────────────────────────────────────────
async function auditEnrichmentJobs() {
  console.log('  Checking enrichment jobs...');

  const jobs = await q(`
    SELECT id, status, total_companies, processed_companies, credits_used
    FROM signal_enrichment_jobs
    WHERE status IN ('running', 'paused')
    ORDER BY started_at DESC LIMIT 5
  `);
  if (jobs?.length > 0) {
    for (const job of jobs) {
      flag('INFO', 'enrichment', `Job ${job.id.substring(0, 8)} — ${job.status}: ${job.processed_companies}/${job.total_companies} companies, ${job.credits_used} credits`,
        'Paused jobs resume when Apollo budget replenishes');
    }
  }
}

// ── 8. MSAL email readiness ───────────────────────────────────────────
async function auditEmailReadiness() {
  console.log('  Checking email readiness...');

  const tokens = await q(`
    SELECT partition_key, updated_at FROM msal_token_cache
  `);
  if (!tokens?.length) {
    flag('LOW', 'email', 'No MSAL token cache entries',
      'No reps have email tokens cached — follow-up emails will fail. Reps need to re-login.');
  } else {
    for (const t of tokens) {
      const age = (Date.now() - new Date(t.updated_at).getTime()) / 3600000;
      if (age > 24) {
        flag('LOW', 'email', `MSAL token for ${t.partition_key} is ${Math.round(age)}h old`,
          'Token may be expired. Rep should re-login to refresh.');
      }
    }
  }
}

// ── 9. Cross-system data consistency ──────────────────────────────────
async function auditCrossSystem() {
  console.log('  Checking cross-system consistency...');

  // customer_interactions channels
  const channels = await q(`
    SELECT channel, count(*) as cnt
    FROM customer_interactions
    GROUP BY channel ORDER BY cnt DESC
  `);
  if (channels) {
    const channelSummary = channels.map(r => `${r.channel}:${r.cnt}`).join(', ');
    flag('INFO', 'cross-system', `customer_interactions channels: ${channelSummary}`,
      'Shared table usage across nucleus-phone and UCIL');
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== System Health Audit ===\n');

  await auditTables();
  await auditSignalPipeline();
  await auditCreditTracking();
  await auditFirefliesSync();
  await auditUCILVoice();
  await auditNucleusCalls();
  await auditEnrichmentJobs();
  await auditEmailReadiness();
  await auditCrossSystem();

  // Print results
  const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], INFO: [] };
  for (const issue of issues) {
    bySeverity[issue.severity].push(issue);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`AUDIT RESULTS: ${issues.length} findings`);
  console.log(`${'='.repeat(60)}\n`);

  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']) {
    const items = bySeverity[severity];
    if (!items.length) continue;

    const icon = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵', INFO: 'ℹ️' }[severity];
    console.log(`${icon} ${severity} (${items.length})`);
    for (const item of items) {
      console.log(`  [${item.system}] ${item.title}`);
      console.log(`    → ${item.detail}`);
    }
    console.log();
  }

  // Summary counts
  console.log(`${'─'.repeat(60)}`);
  console.log(`Critical: ${bySeverity.CRITICAL.length}  High: ${bySeverity.HIGH.length}  Medium: ${bySeverity.MEDIUM.length}  Low: ${bySeverity.LOW.length}  Info: ${bySeverity.INFO.length}`);
  console.log(`${'─'.repeat(60)}`);

  await pool.end();
}

main().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
