#!/usr/bin/env node
/**
 * scripts/enrich-phones-dropcontact.js
 *
 * Batch enrich v35_pb_contacts with phone numbers via Dropcontact.
 * Input: first_name + last_name + company_name → Output: phone number
 *
 * Dropcontact is pay-on-success (credits only consumed when data found),
 * synchronous response (no webhook needed), and we have a year of credits.
 *
 * Processes contacts at signal-scored companies first (highest value).
 * Batches of 50 (Dropcontact batch limit), polls for results, updates DB.
 *
 * Usage:
 *   node scripts/enrich-phones-dropcontact.js [--dry-run] [--limit N] [--all]
 *
 *   --dry-run   Show what would be enriched without calling API
 *   --limit N   Max contacts to process (default 500)
 *   --all       Enrich all PB contacts, not just those at signal-scored companies
 */

require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const DROPCONTACT_API_KEY = process.env.DROPCONTACT_API_KEY;
if (!DROPCONTACT_API_KEY) {
  // Try reading from file (v35-scripts pattern)
  const fs = require('fs');
  const keyFile = '/Users/Shared/joruva-v35-scripts/dropcontact.txt';
  try {
    process.env.DROPCONTACT_API_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    console.error('DROPCONTACT_API_KEY not set and dropcontact.txt not found');
    process.exit(1);
  }
}

const API_KEY = process.env.DROPCONTACT_API_KEY;
const BASE_URL = 'https://api.dropcontact.io/batch';
const BATCH_SIZE = 50; // Dropcontact batch limit
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 120000;

const DRY_RUN = process.argv.includes('--dry-run');
const ALL_CONTACTS = process.argv.includes('--all');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 500;
})();

async function submitBatch(contacts) {
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Token': API_KEY },
    body: JSON.stringify({ data: contacts }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Dropcontact submit failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.request_id) throw new Error('No request_id in response');
  return data.request_id;
}

async function pollResults(requestId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const resp = await fetch(`${BASE_URL}/${requestId}`, {
      headers: { 'X-Access-Token': API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Dropcontact poll failed: ${resp.status}`);
    const data = await resp.json();
    if (data.success && data.data) return data.data;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Dropcontact poll timed out after ${POLL_TIMEOUT_MS}ms`);
}

async function run() {
  console.log(`\n=== Dropcontact Phone Enrichment ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Scope: ${ALL_CONTACTS ? 'All PB contacts' : 'Signal-scored companies only'}`);
  console.log(`Limit: ${LIMIT}\n`);

  // Find contacts that need phone enrichment
  const query = ALL_CONTACTS
    ? `SELECT id, full_name, first_name, last_name, company_name, company_name_norm
       FROM v35_pb_contacts
       WHERE phone IS NULL
         AND first_name IS NOT NULL AND last_name IS NOT NULL
         AND company_name IS NOT NULL
       ORDER BY id
       LIMIT $1`
    : `SELECT pb.id, pb.full_name, pb.first_name, pb.last_name, pb.company_name, pb.company_name_norm
       FROM v35_pb_contacts pb
       WHERE pb.phone IS NULL
         AND pb.first_name IS NOT NULL AND pb.last_name IS NOT NULL
         AND pb.company_name IS NOT NULL
         AND (
           pb.domain IN (SELECT domain FROM v35_signal_metadata WHERE signal_tier IN ('spear', 'targeted'))
           OR EXISTS (
             SELECT 1 FROM v35_signal_metadata sm
             JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
             WHERE LOWER(REGEXP_REPLACE(lr.company_name, ',?\\s*(Inc\\.?|LLC|Corp\\.?|Ltd\\.?|Co\\.?|LP|L\\.P\\.?)\\s*$', '', 'i'))
                   = pb.company_name_norm
           )
         )
       ORDER BY pb.id
       LIMIT $1`;

  const result = await pool.query(query, [LIMIT]);
  const contacts = result.rows;
  console.log(`Found ${contacts.length} contacts needing phone enrichment\n`);

  if (contacts.length === 0) {
    console.log('Nothing to enrich.');
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    for (const c of contacts.slice(0, 20)) {
      console.log(`  ${c.first_name} ${c.last_name} @ ${c.company_name}`);
    }
    if (contacts.length > 20) console.log(`  ... and ${contacts.length - 20} more`);
    console.log(`\nDry run complete. Run without --dry-run to enrich.`);
    await pool.end();
    return;
  }

  // Process in batches
  let totalProcessed = 0;
  let phonesFound = 0;
  let batchNum = 0;

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);
    batchNum++;
    console.log(`Batch ${batchNum}: ${batch.length} contacts (${i + 1}-${i + batch.length} of ${contacts.length})`);

    // Format for Dropcontact API
    const dcBatch = batch.map(c => ({
      first_name: c.first_name,
      last_name: c.last_name,
      company: c.company_name,
    }));

    try {
      const requestId = await submitBatch(dcBatch);
      console.log(`  Submitted → ${requestId}, polling...`);

      const results = await pollResults(requestId);
      console.log(`  Results: ${results.length} contacts returned`);

      // Update DB with phone numbers
      let batchPhones = 0;
      for (let j = 0; j < results.length; j++) {
        const dc = results[j];
        const original = batch[j];
        const phone = dc.phone || null;

        if (phone) {
          await pool.query(
            `UPDATE v35_pb_contacts SET phone = $1 WHERE id = $2 AND phone IS NULL`,
            [phone, original.id],
          );
          batchPhones++;
          console.log(`    ✓ ${original.first_name} ${original.last_name} → ${phone}`);
        }
      }

      phonesFound += batchPhones;
      totalProcessed += batch.length;
      console.log(`  Phones found: ${batchPhones}/${batch.length}\n`);

      // Brief pause between batches
      if (i + BATCH_SIZE < contacts.length) await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error(`  Batch ${batchNum} failed: ${err.message}`);
      // Continue to next batch
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Processed: ${totalProcessed}`);
  console.log(`Phones found: ${phonesFound}`);
  console.log(`Hit rate: ${totalProcessed > 0 ? ((phonesFound / totalProcessed) * 100).toFixed(1) : 0}%`);

  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
