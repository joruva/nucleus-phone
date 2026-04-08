#!/usr/bin/env node
/**
 * scripts/test-webhook-delivery.js — Phase 0b: Validate Apollo webhook delivery.
 *
 * Calls /people/match for a known contact with reveal_phone_number=true,
 * logs the synchronous response shape, then polls the DB to see if the
 * webhook handler updated the phone column.
 *
 * Usage: node scripts/test-webhook-delivery.js [email]
 * Default test email: mschwartz@sechan.com (known Apollo contact with phone=NULL)
 *
 * Costs 8 Apollo credits (one phone reveal).
 */

require('dotenv').config();

const API_KEY = process.env.APOLLO_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_URL = process.env.APOLLO_PHONE_WEBHOOK_URL
  || 'https://nucleus-phone.onrender.com/api/apollo/phone-webhook';

if (!API_KEY) { console.error('APOLLO_API_KEY not set'); process.exit(1); }
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const { Pool } = require('pg');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const testEmail = process.argv[2] || 'mschwartz@sechan.com';

async function main() {
  console.log(`\n=== Phase 0b: Apollo Webhook Delivery Test ===\n`);
  console.log(`Test contact: ${testEmail}`);
  console.log(`Webhook URL:  ${WEBHOOK_URL}\n`);

  // Step 1: Verify contact exists in DB with no phone
  const pre = await pool.query(
    `SELECT id, full_name, email, phone, domain FROM v35_pb_contacts
     WHERE email = $1 AND source = 'apollo'`,
    [testEmail],
  );

  if (pre.rows.length === 0) {
    console.error(`Contact ${testEmail} not found in v35_pb_contacts (source=apollo)`);
    process.exit(1);
  }

  const contact = pre.rows[0];
  console.log(`DB state BEFORE reveal:`);
  console.log(`  ID: ${contact.id} | Name: ${contact.full_name} | Phone: ${contact.phone || 'NULL'}\n`);

  // Step 2: Call /people/match with email + reveal_phone_number + webhook_url
  console.log(`Calling Apollo /people/match with reveal_phone_number=true...`);
  console.log(`  webhook_url: ${WEBHOOK_URL}\n`);

  const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
    body: JSON.stringify({
      email: testEmail,
      reveal_phone_number: true,
      webhook_url: WEBHOOK_URL,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const rateLimitRemaining = resp.headers.get('x-rate-limit-remaining');
  const creditUsed = resp.headers.get('x-usage-credit-used');
  console.log(`HTTP ${resp.status} | Rate limit remaining: ${rateLimitRemaining} | Credits used: ${creditUsed}`);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`Apollo error: ${text.substring(0, 500)}`);
    process.exit(1);
  }

  const data = await resp.json();
  const person = data.person;

  if (!person) {
    console.error('No person object in response');
    console.log('Full response:', JSON.stringify(data).substring(0, 500));
    process.exit(1);
  }

  // Step 3: Log the synchronous response — what fields do we get?
  console.log(`\nSynchronous response person fields:`);
  console.log(`  id:              ${person.id}`);
  console.log(`  name:            ${person.name}`);
  console.log(`  email:           ${person.email}`);
  console.log(`  title:           ${person.title}`);
  console.log(`  linkedin_url:    ${person.linkedin_url}`);
  console.log(`  sanitized_phone: ${person.sanitized_phone || 'NULL'}`);
  console.log(`  primary_phone:   ${JSON.stringify(person.primary_phone) || 'NULL'}`);
  console.log(`  phone_numbers:   ${JSON.stringify(person.phone_numbers) || '[]'}`);
  console.log(`  organization:    ${person.organization?.name || 'N/A'}`);

  // Store apollo_person_id so the webhook handler can match
  if (person.id) {
    await pool.query(
      `UPDATE v35_pb_contacts SET apollo_person_id = $1 WHERE email = $2 AND source = 'apollo'`,
      [person.id, testEmail],
    );
    console.log(`\nStored apollo_person_id: ${person.id}`);
  }

  // Key question: does the sync response already have the phone?
  const syncPhone = person.sanitized_phone
    || person.primary_phone?.number
    || person.phone_numbers?.[0]?.sanitized_number;

  if (syncPhone) {
    console.log(`\n*** SYNC RESPONSE CONTAINS PHONE: ${syncPhone} ***`);
    console.log(`This means phones are NOT async-only. The webhook may be redundant.`);
  } else {
    console.log(`No phone in sync response — expecting async webhook delivery.`);
  }

  // Step 4: Poll DB for webhook update (2min window, check every 10s)
  console.log(`\nPolling DB for webhook phone update (2min window)...`);

  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 10000));

    const post = await pool.query(
      `SELECT phone FROM v35_pb_contacts WHERE email = $1 AND source = 'apollo'`,
      [testEmail],
    );

    const updatedPhone = post.rows[0]?.phone;
    if (updatedPhone) {
      console.log(`  [${(i + 1) * 10}s] WEBHOOK DELIVERED — phone updated to: ${updatedPhone}`);
      console.log(`\n=== RESULT: Webhook pipeline is working end-to-end ===`);
      await pool.end();
      return;
    }
    console.log(`  [${(i + 1) * 10}s] phone still NULL...`);
  }

  console.log(`\n=== RESULT: No webhook received in 2 minutes ===`);
  console.log(`The webhook handler is now deployed with correct payload parsing.`);
  console.log(`Apollo says delivery can take "several minutes." Check Render logs later.`);
  console.log(`  grep for: "Apollo webhook raw:" in Render logs`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
