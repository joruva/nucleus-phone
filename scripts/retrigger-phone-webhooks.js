#!/usr/bin/env node
/**
 * scripts/retrigger-phone-webhooks.js
 *
 * Re-trigger Apollo phone webhooks for already-revealed contacts.
 * This costs ZERO credits — Apollo caches reveals and re-sends the webhook.
 *
 * Calls /people/match with reveal_phone_number=true for each contact that
 * has an apollo_person_id. The webhook delivers the real mobile/direct number,
 * which the (fixed) webhook handler stores — overwriting any stale corporate number.
 *
 * Usage:
 *   node scripts/retrigger-phone-webhooks.js [--dry-run] [--limit N] [--batch-size N]
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const WEBHOOK_URL = process.env.APOLLO_PHONE_WEBHOOK_URL
  || 'https://nucleus-phone.onrender.com/api/apollo/phone-webhook';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 0; // 0 = no limit
})();
const BATCH_PAUSE_MS = 1500; // ~40 req/min, well under Apollo's 50/min limit

async function triggerReveal(apolloPersonId) {
  const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
    body: JSON.stringify({
      id: apolloPersonId,
      reveal_phone_number: true,
      webhook_url: WEBHOOK_URL,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, status: resp.status, error: text.substring(0, 200) };
  }

  const data = await resp.json();
  return { ok: true, name: data.person?.name };
}

async function run() {
  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';

  const { rows: contacts } = await pool.query(
    `SELECT id, full_name, email, phone, apollo_person_id, domain
     FROM v35_pb_contacts
     WHERE source = 'apollo' AND apollo_person_id IS NOT NULL
     ORDER BY
       CASE WHEN phone IS NULL THEN 0 ELSE 1 END, -- missing phones first
       id
     ${limitClause}`,
  );

  const withPhone = contacts.filter(c => c.phone).length;
  const noPhone = contacts.filter(c => !c.phone).length;

  console.log(`\n=== Apollo Phone Webhook Re-trigger ===`);
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Contacts:       ${contacts.length} (${noPhone} missing phone, ${withPhone} with phone)`);
  console.log(`Webhook:        ${WEBHOOK_URL}`);
  console.log(`Rate:           ~${Math.round(60000 / BATCH_PAUSE_MS)} req/min`);
  console.log(`Est. time:      ~${Math.round(contacts.length * BATCH_PAUSE_MS / 60000)} min`);
  console.log();

  if (!contacts.length) { await pool.end(); return; }

  let triggered = 0, failed = 0, creditErrors = 0;

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const prefix = `[${i + 1}/${contacts.length}]`;

    if (DRY_RUN) {
      console.log(`  ${prefix} Would re-trigger: ${c.full_name} (${c.domain}) phone=${c.phone || 'NULL'}`);
      triggered++;
      continue;
    }

    try {
      const result = await triggerReveal(c.apollo_person_id);

      if (result.ok) {
        console.log(`  ${prefix} ✓ ${c.full_name} (${c.domain})`);
        triggered++;
      } else if (result.status === 422) {
        console.error(`  ${prefix} ⛔ ${c.full_name} — 422: ${result.error}`);
        creditErrors++;
        // If we get a credit error, Apollo may be charging — STOP immediately
        if (result.error.includes('insufficient') || result.error.includes('credit')) {
          console.error('\n⛔ CREDIT ERROR — stopping to avoid unexpected charges.');
          console.error('This was supposed to be free for already-revealed contacts.');
          console.error('Investigate before continuing.\n');
          break;
        }
      } else {
        console.error(`  ${prefix} ✗ ${c.full_name} — ${result.status}: ${result.error}`);
        failed++;
      }

      // Rate limit
      if (i < contacts.length - 1) {
        await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
      }
    } catch (err) {
      console.error(`  ${prefix} ! ${c.full_name} — ${err.message}`);
      failed++;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Triggered:      ${triggered}`);
  console.log(`Failed:         ${failed}`);
  console.log(`Credit errors:  ${creditErrors}`);
  console.log(`\nWebhooks will arrive over the next few minutes.`);
  console.log(`Check DB after ~5 min: SELECT COUNT(*) FROM v35_pb_contacts WHERE source = 'apollo' AND phone IS NOT NULL;`);

  await pool.end();
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
