#!/usr/bin/env node
/**
 * scripts/test-apollo-people-search.js
 *
 * Validates Apollo's /v1/mixed_people/api_search endpoint before building
 * the batch enrichment system (Phase 4b). Run this ONCE to confirm:
 *   - Auth works with our API key
 *   - Response shape matches expectations
 *   - Phone numbers are returned (or not)
 *   - Credit cost per call
 *   - Empty result handling
 *
 * Usage: node scripts/test-apollo-people-search.js
 *
 * Requires APOLLO_API_KEY env var. Costs 1 credit per search call.
 */

require('dotenv').config();

const BASE_URL = 'https://api.apollo.io/api/v1';
const API_KEY = process.env.APOLLO_API_KEY;

if (!API_KEY) {
  console.error('APOLLO_API_KEY not set. Add it to .env or export it.');
  process.exit(1);
}

const TITLE_FILTERS = [
  'VP Operations', 'Director of Operations',
  'Director of Quality', 'Quality Manager',
  'Plant Manager', 'General Manager',
  'Purchasing Manager', 'Procurement Director',
  'Maintenance Director',
  'CFO', 'Owner',
];

// Use a known signal-scored company for testing.
// Pick one from v35_signal_metadata or use a well-known manufacturer.
const TEST_DOMAIN = process.argv[2] || 'precisioncastparts.com';

async function apolloFetch(path, body) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const rateLimitRemaining = resp.headers.get('x-rate-limit-remaining');
  const creditUsed = resp.headers.get('x-usage-credit-used');

  console.log(`  HTTP ${resp.status} | Rate limit remaining: ${rateLimitRemaining} | Credits used: ${creditUsed}`);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Apollo ${resp.status}: ${text.substring(0, 300)}`);
  }

  return resp.json();
}

async function testPeopleSearch() {
  console.log(`\n=== Apollo People Search Validation ===\n`);
  console.log(`Test domain: ${TEST_DOMAIN}`);
  console.log(`Title filters: ${TITLE_FILTERS.slice(0, 3).join(', ')}... (${TITLE_FILTERS.length} total)\n`);

  // Test 1: Search by domain + title filters
  console.log('--- Test 1: People search by company domain + titles ---');
  try {
    const data = await apolloFetch('/mixed_people/api_search', {
      organization_domains: [TEST_DOMAIN],
      person_titles: TITLE_FILTERS,
      page: 1,
      per_page: 10,
    });

    const people = data.people || [];
    console.log(`  Found ${people.length} people (of ${data.pagination?.total_entries || '?'} total)`);

    if (people.length > 0) {
      console.log('\n  Sample contacts:');
      for (const p of people.slice(0, 5)) {
        const phone = p.phone_numbers?.[0]?.sanitized_number || p.organization?.phone || null;
        console.log(`    ${p.name || 'N/A'} — ${p.title || 'N/A'}`);
        console.log(`      Email: ${p.email || 'N/A'} | Phone: ${phone || 'NONE'}`);
        console.log(`      LinkedIn: ${p.linkedin_url || 'N/A'}`);
      }

      // Analyze phone coverage
      const withPhone = people.filter(p => p.phone_numbers?.length > 0 || p.organization?.phone);
      console.log(`\n  Phone coverage: ${withPhone.length}/${people.length} contacts have phone numbers`);
    }

    console.log('\n  Response keys:', Object.keys(data).join(', '));
    if (data.pagination) console.log('  Pagination:', JSON.stringify(data.pagination));

  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
  }

  // Test 2: Search with no results (nonsense domain)
  console.log('\n--- Test 2: Empty result handling (fake domain) ---');
  try {
    const data = await apolloFetch('/mixed_people/api_search', {
      organization_domains: ['this-company-does-not-exist-xyz123.com'],
      person_titles: ['CEO'],
      page: 1,
      per_page: 5,
    });

    const people = data.people || [];
    console.log(`  Found ${people.length} people (expected 0)`);
    console.log(`  Response keys: ${Object.keys(data).join(', ')}`);
    console.log(`  ${people.length === 0 ? 'PASS' : 'UNEXPECTED: got results for fake domain'}`);

  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
  }

  // Test 3: Search by domain only (no title filter) to see full org
  console.log('\n--- Test 3: Domain-only search (no title filter) ---');
  try {
    const data = await apolloFetch('/mixed_people/api_search', {
      organization_domains: [TEST_DOMAIN],
      page: 1,
      per_page: 5,
    });

    const people = data.people || [];
    console.log(`  Found ${people.length} people (of ${data.pagination?.total_entries || '?'} total)`);
    if (people.length > 0) {
      console.log(`  Titles: ${people.map(p => p.title || 'N/A').join(', ')}`);
    }

  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
  }

  console.log('\n=== Validation Complete ===');
  console.log('Review the output above. Key questions:');
  console.log('  1. Do phone numbers come back? (phone_numbers array)');
  console.log('  2. What is the credit cost per call? (check x-usage-credit-used header)');
  console.log('  3. Does the title filter actually restrict results?');
  console.log('  4. What fields are available on each person object?');
}

testPeopleSearch().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
