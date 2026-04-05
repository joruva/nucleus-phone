#!/usr/bin/env node
/**
 * scripts/run-enrichment-uncapped.js
 *
 * Run signal enrichment WITHOUT credit gate. One-time use for backfilling
 * contacts after bulk domain resolution.
 *
 * Usage: node scripts/run-enrichment-uncapped.js [--dry-run] [--limit N]
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');
const { searchPeopleByCompany } = require('../server/lib/apollo');
const { normalizeCompanyName } = require('../server/lib/company-normalizer');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 500;
})();

async function run() {
  console.log(`\n=== Signal Enrichment (Uncapped) ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Apollo key: ${process.env.APOLLO_API_KEY ? 'set' : 'MISSING'}\n`);

  if (!process.env.APOLLO_API_KEY) {
    console.error('APOLLO_API_KEY not set');
    process.exit(1);
  }

  // Find SPEAR+TARGETED companies with real domains but no Apollo contacts
  const { rows: companies } = await pool.query(
    `SELECT sm.domain, lr.company_name, sm.signal_tier, sm.signal_score
     FROM v35_signal_metadata sm
     JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
     WHERE sm.signal_tier IN ('spear', 'targeted')
       AND sm.domain NOT LIKE '%.signal-pending'
       AND NOT EXISTS (
         SELECT 1 FROM v35_pb_contacts pb
         WHERE pb.domain = sm.domain AND pb.source = 'apollo'
       )
     ORDER BY sm.signal_score DESC
     LIMIT $1`,
    [LIMIT],
  );

  console.log(`Found ${companies.length} companies needing enrichment\n`);
  if (!companies.length) {
    console.log('Nothing to do.');
    await pool.end();
    return;
  }

  let totalContacts = 0;
  let totalCredits = 0;
  let processed = 0;
  let noResults = 0;
  let errors = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];

    try {
      if (DRY_RUN) {
        console.log(`  [${i + 1}/${companies.length}] Would enrich: ${c.company_name} (${c.domain})`);
        processed++;
        continue;
      }

      const result = await searchPeopleByCompany(c.domain);
      const { previews, contacts, creditsUsed } = result;

      if (contacts.length === 0) {
        console.log(`  [${i + 1}/${companies.length}] ○ ${c.company_name} — ${previews.length} previews, 0 with phone`);
        noResults++;
      } else {
        // Upsert contacts
        const norm = normalizeCompanyName(c.company_name);
        for (const contact of contacts) {
          if (!contact.email && !contact.linkedin_url) continue;

          await pool.query(
            `INSERT INTO v35_pb_contacts
               (full_name, first_name, last_name, title, company_name, company_name_norm,
                linkedin_profile_url, email, phone, domain, source, enrichment_batch_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'apollo', 'uncapped-backfill')
             ON CONFLICT (domain, email)
               WHERE source = 'apollo' AND email IS NOT NULL
             DO UPDATE SET
               phone = COALESCE(EXCLUDED.phone, v35_pb_contacts.phone),
               title = COALESCE(EXCLUDED.title, v35_pb_contacts.title),
               linkedin_profile_url = COALESCE(EXCLUDED.linkedin_profile_url, v35_pb_contacts.linkedin_profile_url)`,
            [
              contact.name, contact.first_name, contact.last_name, contact.title,
              c.company_name, norm,
              contact.linkedin_url, contact.email, contact.phone, c.domain,
            ],
          );
        }

        console.log(`  [${i + 1}/${companies.length}] ✓ ${c.company_name} — ${contacts.length} contacts (${creditsUsed} credits)`);
        totalContacts += contacts.length;
      }

      totalCredits += creditsUsed;
      processed++;

      // Rate limit: ~1 req/sec (Apollo search is free, reveals are throttled)
      if (i < companies.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`  [${i + 1}/${companies.length}] ! ${c.company_name} — ${err.message}`);
      errors++;
      // Throttle on errors (might be rate limit)
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Companies processed: ${processed}`);
  console.log(`Contacts found:      ${totalContacts}`);
  console.log(`Credits consumed:    ${totalCredits}`);
  console.log(`No results:          ${noResults}`);
  console.log(`Errors:              ${errors}`);
  console.log(`Total:               ${companies.length}`);

  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
