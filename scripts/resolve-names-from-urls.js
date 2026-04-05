#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
/**
 * Resolve truncated last names from LinkedIn URL slugs.
 * e.g., "Gary E." + URL "linkedin.com/in/garyeberhart" → "Gary Eberhart"
 *       "Erik T." + URL "linkedin.com/in/erik-topp" → "Erik Topp"
 *
 * Heuristic: extract slug, split by hyphen, match first name to confirm,
 * capitalize remaining parts as last name. Skip ambiguous cases.
 */

const { pool } = require('../server/db');

const DRY_RUN = process.argv.includes('--dry-run');

function extractNameFromSlug(slug, firstName) {
  if (!slug || !firstName) return null;

  // Remove trailing numbers/disambiguators and title suffixes
  const clean = slug
    .replace(/-[a-f0-9]{6,}$/, '')   // hex disambiguators: -538bb433
    .replace(/-?\d+$/, '')            // numeric disambiguators: -9414114 or 8190
    .replace(/-(mba|phd|pe|cpa|pmp|cfa|csm|six-sigma|lean|ehs|mfg-leader|plant-manager|strategic-advisor|engineering|mgr|aeromgr)$/i, ''); // title/credential suffixes

  // Try hyphenated format: "erik-topp" or "kurt-dehnel" or "amir-dehghan"
  const parts = clean.split('-');
  if (parts.length >= 2) {
    const first = parts[0].toLowerCase();
    if (first === firstName.toLowerCase()) {
      const last = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
      if (last.length >= 2) return { firstName: capitalize(parts[0]), lastName: last };
    }
  }

  // Try concatenated format: "garyeberhart" or "laurenruka"
  const lower = clean.toLowerCase();
  const firstLower = firstName.toLowerCase();
  if (lower.startsWith(firstLower) && lower.length > firstLower.length + 1) {
    const rest = clean.slice(firstLower.length);
    // Only accept if the remaining part looks like a name (3+ chars, alpha, no digits)
    if (rest.length >= 3 && rest.length <= 20 && /^[a-z]+$/i.test(rest)) {
      return { firstName: capitalize(firstLower), lastName: capitalize(rest) };
    }
  }

  return null;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, full_name, first_name, last_name,
           raw_data->>'defaultProfileUrl' AS default_url
    FROM v35_pb_contacts
    WHERE last_name ~ '^\\w\\.$'
      AND raw_data->>'defaultProfileUrl' IS NOT NULL
  `);

  console.log(`Found ${rows.length} truncated contacts with LinkedIn URLs`);
  let resolved = 0, skipped = 0;

  for (const row of rows) {
    const url = row.default_url;
    const slug = url?.match(/linkedin\.com\/in\/([^/?]+)/)?.[1];
    if (!slug) { skipped++; continue; }

    const result = extractNameFromSlug(slug, row.first_name);
    if (!result) { skipped++; continue; }

    const fullName = `${result.firstName} ${result.lastName}`;
    console.log(`  ✓ ${row.full_name} → ${fullName} (from slug: ${slug})`);

    if (!DRY_RUN) {
      await pool.query(`
        UPDATE v35_pb_contacts
        SET full_name = $1, first_name = $2, last_name = $3
        WHERE id = $4
      `, [fullName, result.firstName, result.lastName, row.id]);
    }
    resolved++;
  }

  console.log(`\nDone: ${resolved} resolved, ${skipped} skipped (ambiguous or no URL)`);
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
