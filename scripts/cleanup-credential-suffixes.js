#!/usr/bin/env node
/**
 * scripts/cleanup-credential-suffixes.js
 *
 * Strips professional credential suffixes from last_name in v35_pb_contacts.
 * Examples: "Hines, P.E." → "Hines", "Frye C.P.M., A.P.P." → "Frye", "Knox Ph.D." → "Knox"
 *
 * Usage: node scripts/cleanup-credential-suffixes.js [--dry-run]
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const DRY_RUN = process.argv.includes('--dry-run');

// Known credential patterns — order matters (longest first to avoid partial matches)
const CREDENTIAL_PATTERNS = [
  /,?\s+C\.P\.M\.,?\s*A\.P\.P\.$/i,
  /,?\s+(?:P\.E\.|Ph\.D\.|M\.B\.A\.|M\.S\.|C\.P\.A\.|C\.P\.M\.|A\.P\.P\.|J\.D\.|R\.N\.|P\.M\.P\.|C\.F\.P\.|C\.E\.M\.|C\.S\.P\.|LEED\s*A\.?P\.?|PMP|MBA|CPA|PE)$/i,
  /,?\s+(?:Jr\.|Sr\.|III|IV|II)$/i,  // Keep — these are name suffixes, not credentials
];

// Only strip credentials, NOT name suffixes like Jr./Sr./III
const STRIP_PATTERNS = [
  /,?\s+C\.P\.M\.,?\s*A\.P\.P\.$/i,
  /,?\s+(?:P\.E\.|Ph\.D\.|M\.B\.A\.|M\.S\.|C\.P\.A\.|C\.P\.M\.|A\.P\.P\.|J\.D\.|R\.N\.|P\.M\.P\.|C\.F\.P\.|C\.E\.M\.|C\.S\.P\.|LEED\s*A\.?P\.?)$/i,
  /,?\s+(?:PMP|MBA|CPA|PE)$/i,
];

function stripCredentials(lastName) {
  let cleaned = lastName;
  // Apply patterns repeatedly in case of stacked credentials
  let changed = true;
  while (changed) {
    changed = false;
    for (const pat of STRIP_PATTERNS) {
      const result = cleaned.replace(pat, '');
      if (result !== cleaned) {
        cleaned = result;
        changed = true;
      }
    }
  }
  return cleaned.trim().replace(/,\s*$/, '').trim();
}

async function run() {
  // Find contacts whose last_name ends with a period but isn't just an initial
  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, full_name
     FROM v35_pb_contacts
     WHERE last_name ~ '\\.$'
       AND last_name !~ '^\\w\\.$'
     ORDER BY last_name`,
  );

  console.log(`Found ${rows.length} contacts with potential credential suffixes.\n`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const cleaned = stripCredentials(row.last_name);
    if (cleaned === row.last_name) {
      skipped++;
      continue;
    }

    const cleanedFull = row.full_name
      ? row.full_name.replace(row.last_name, cleaned)
      : `${row.first_name} ${cleaned}`;

    console.log(`  ${row.last_name} → ${cleaned}  (${row.first_name} ${row.last_name})`);

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE v35_pb_contacts SET last_name = $1, full_name = $2 WHERE id = $3`,
        [cleaned, cleanedFull, row.id],
      );
    }
    updated++;
  }

  console.log(`\nUpdated: ${updated}  Skipped: ${skipped}  Total scanned: ${rows.length}`);
  if (DRY_RUN) console.log('Dry run — no changes applied.');

  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
