#!/usr/bin/env node
/**
 * One-shot test: re-reveal an already-revealed contact to check:
 * 1. Does it cost credits? (check ledger before/after)
 * 2. Does the webhook fire with real direct/mobile numbers?
 *
 * Usage: node scripts/test-rereveal.js
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const WEBHOOK_URL = process.env.APOLLO_PHONE_WEBHOOK_URL
  || 'https://nucleus-phone.onrender.com/api/apollo/phone-webhook';

// Brian Angle at buffalorock.com — currently has corporate number +12059423435
const TEST_PERSON_ID = '651289454e21ed0001fb2da6';
const TEST_EMAIL = 'bangle@buffalorock.com';

async function main() {
  console.log('=== Re-reveal test ===');
  console.log(`Person: ${TEST_EMAIL} (${TEST_PERSON_ID})`);
  console.log(`Webhook: ${WEBHOOK_URL}\n`);

  // Step 1: call /people/match with reveal_phone_number=true
  console.log('Calling /people/match with reveal_phone_number=true...');
  const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
    body: JSON.stringify({
      id: TEST_PERSON_ID,
      reveal_phone_number: true,
      webhook_url: WEBHOOK_URL,
    }),
    signal: AbortSignal.timeout(15000),
  });

  console.log(`Status: ${resp.status}`);

  if (!resp.ok) {
    const text = await resp.text();
    console.error('FAILED:', text.substring(0, 500));
    process.exit(1);
  }

  const data = await resp.json();
  const p = data.person;

  if (!p) {
    console.log('No person in response');
    process.exit(1);
  }

  console.log('\n--- Sync response fields ---');
  console.log('name:', p.name);
  console.log('email:', p.email);
  console.log('title:', p.title);
  console.log('sanitized_phone:', p.sanitized_phone, '← this is the corporate number');
  console.log('phone_numbers:', JSON.stringify(p.phone_numbers));
  console.log('primary_phone:', JSON.stringify(p.primary_phone));
  console.log('organization.name:', p.organization?.name);
  console.log('organization.phone:', p.organization?.phone, '← org phone for comparison');

  console.log('\n--- Credits ---');
  console.log('Check Render logs for webhook delivery in ~10s.');
  console.log('Check v35_credit_daily_ledger to see if consumed incremented.');
  console.log('Enable DEBUG_APOLLO_WEBHOOK=true on Render to see raw webhook payload.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
