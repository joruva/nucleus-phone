#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
/**
 * Resolve truncated last names via web search.
 * Searches "[FirstName] [Title] [Company] linkedin" and extracts full name from results.
 * Zero credit cost — uses Google search snippets, not paid APIs.
 */

const { pool } = require('../server/db');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--limit') || '200', 10);
const DELAY_MS = 2000; // Be polite to search engines

async function searchForName(firstName, lastInitial, title, company, location) {
  const query = `"${firstName}" "${title}" "${company}" linkedin`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) return null;
  const html = await resp.text();

  // Extract names from LinkedIn profile titles in search results
  // Pattern: "FirstName LastName - Title - Company | LinkedIn"
  const initial = lastInitial.replace('.', '').toLowerCase();
  const pattern = new RegExp(
    `(${firstName}\\s+${initial}[a-z]+(?:\\s+[A-Z][a-z]+)?)\\s*[-–—|]`,
    'i'
  );
  const match = html.match(pattern);
  if (match) {
    const fullName = match[1].trim();
    // Verify it starts with the right first name and last name starts with the initial
    const parts = fullName.split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1].toLowerCase().startsWith(initial)) {
      return fullName;
    }
  }

  // Fallback: look for "FirstName LastInitial..." in any LinkedIn URL title format
  const altPattern = new RegExp(
    `>${firstName}\\s+(${initial}[a-z]{2,})`,
    'i'
  );
  const altMatch = html.match(altPattern);
  if (altMatch) {
    const lastName = altMatch[1].charAt(0).toUpperCase() + altMatch[1].slice(1).toLowerCase();
    return `${firstName} ${lastName}`;
  }

  return null;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, full_name, first_name, last_name, title, company_name, location
    FROM v35_pb_contacts
    WHERE last_name ~ '^\\w\\.$'
    ORDER BY phone IS NOT NULL DESC, id
    LIMIT $1
  `, [LIMIT]);

  console.log(`Found ${rows.length} contacts with truncated last names`);
  let resolved = 0, failed = 0;

  for (const row of rows) {
    try {
      const fullName = await searchForName(
        row.first_name, row.last_name, row.title, row.company_name, row.location
      );

      if (fullName) {
        const parts = fullName.split(/\s+/);
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ');

        console.log(`  ✓ ${row.full_name} → ${fullName} (${row.company_name})`);

        if (!DRY_RUN) {
          await pool.query(`
            UPDATE v35_pb_contacts
            SET full_name = $1, first_name = $2, last_name = $3
            WHERE id = $4
          `, [fullName, firstName, lastName, row.id]);
        }
        resolved++;
      } else {
        console.log(`  ✗ ${row.full_name} at ${row.company_name} — no match in search results`);
        failed++;
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err) {
      console.log(`  ✗ ${row.full_name} at ${row.company_name} — ${err.message}`);
      failed++;
      await new Promise(r => setTimeout(r, DELAY_MS * 2));
    }
  }

  console.log(`\nDone: ${resolved} resolved, ${failed} failed`);
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
