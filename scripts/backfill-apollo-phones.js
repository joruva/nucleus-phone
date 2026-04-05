#!/usr/bin/env node
/**
 * scripts/backfill-apollo-phones.js
 *
 * Re-match Apollo contacts we already revealed to get their phone numbers.
 * These contacts were stored with phone=null because the revealPerson function
 * was reading the wrong field (phone_numbers[0].sanitized_number instead of
 * sanitized_phone / primary_phone.number).
 *
 * Re-matching by email costs 0 credits — Apollo already has the reveal cached.
 *
 * Usage: node scripts/backfill-apollo-phones.js [--dry-run] [--limit N]
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
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 600;
})();

async function matchByEmail(email) {
  const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
    body: JSON.stringify({ email, reveal_phone_number: true }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const p = data.person;
  if (!p) return null;

  return p.sanitized_phone || p.primary_phone?.number || p.phone_numbers?.[0]?.sanitized_number || null;
}

async function run() {
  console.log(`\n=== Apollo Phone Backfill ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Limit: ${LIMIT}\n`);

  const { rows: contacts } = await pool.query(
    `SELECT id, full_name, email, company_name, domain
     FROM v35_pb_contacts
     WHERE source = 'apollo' AND phone IS NULL AND email IS NOT NULL
     ORDER BY id
     LIMIT $1`,
    [LIMIT],
  );

  console.log(`${contacts.length} Apollo contacts with email but no phone\n`);
  if (!contacts.length) { await pool.end(); return; }

  let found = 0, missed = 0, errors = 0;

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    try {
      if (DRY_RUN) {
        console.log(`  [${i + 1}/${contacts.length}] Would re-match: ${c.full_name} (${c.email})`);
        continue;
      }

      const phone = await matchByEmail(c.email);

      if (phone) {
        await pool.query('UPDATE v35_pb_contacts SET phone = $1 WHERE id = $2', [phone, c.id]);
        console.log(`  [${i + 1}/${contacts.length}] ✓ ${c.full_name} → ${phone}`);
        found++;
      } else {
        console.log(`  [${i + 1}/${contacts.length}] ○ ${c.full_name} — no phone in Apollo`);
        missed++;
      }

      // Rate limit
      if (i < contacts.length - 1) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  [${i + 1}/${contacts.length}] ! ${c.full_name} — ${err.message}`);
      errors++;
      if (err.message.includes('insufficient credits')) {
        console.error('\n⛔ Apollo credits exhausted.');
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Phones found: ${found}`);
  console.log(`No phone:     ${missed}`);
  console.log(`Errors:       ${errors}`);
  console.log(`Total:        ${contacts.length}`);

  await pool.end();
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
