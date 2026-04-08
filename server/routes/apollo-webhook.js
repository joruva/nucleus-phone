/**
 * routes/apollo-webhook.js — Receives async phone number delivery from Apollo.
 *
 * When we call /people/match with reveal_phone_number=true, Apollo sends
 * the phone number asynchronously to this webhook. We update the matching
 * contact row in v35_pb_contacts via apollo_person_id.
 *
 * Apollo webhook payload format:
 *   { status, total_requested_enrichments, people: [{ id, status, phone_numbers }] }
 * Each phone_numbers entry: { sanitized_number, raw_number, type_cd, confidence_cd, status_cd }
 *
 * No auth middleware — Apollo doesn't send auth headers.
 */

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

/**
 * Pick the best phone number from Apollo's phone_numbers array.
 * Prefers mobile/direct with valid status, falls back to first sanitized number.
 */
function pickBestPhone(phoneNumbers) {
  if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) return null;

  const direct = phoneNumbers.find(p =>
    (p.type_cd === 'mobile' || p.type_cd === 'direct')
    && p.status_cd !== 'invalid_number',
  );
  if (direct?.sanitized_number) return direct.sanitized_number;

  const valid = phoneNumbers.find(p => p.status_cd !== 'invalid_number');
  return valid?.sanitized_number || valid?.raw_number
    || phoneNumbers[0]?.sanitized_number || phoneNumbers[0]?.raw_number || null;
}

// POST /api/apollo/phone-webhook — Apollo sends phone numbers here
router.post('/', async (req, res) => {
  try {
    // TODO: Remove after Phase 0b validation complete
    console.log('Apollo webhook raw:', JSON.stringify(req.body).substring(0, 500));

    const body = req.body;

    // Apollo sends { people: [{ id, phone_numbers }] }
    const people = body?.people;
    if (!Array.isArray(people) || people.length === 0) {
      console.warn('Apollo phone webhook: no people array', {
        keys: Object.keys(body || {}),
        status: body?.status,
      });
      return res.json({ received: true, updated: 0 });
    }

    let totalUpdated = 0;

    for (const entry of people) {
      const apolloId = entry.id;
      const phone = pickBestPhone(entry.phone_numbers);

      if (!phone) {
        console.warn('Apollo phone webhook: no usable phone', { apolloId });
        continue;
      }

      // Match by apollo_person_id — the only reliable key in the webhook payload
      const result = await pool.query(
        `UPDATE v35_pb_contacts
         SET phone = $1
         WHERE apollo_person_id = $2 AND source = 'apollo' AND phone IS NULL
         RETURNING id, full_name, email`,
        [phone, apolloId],
      );

      if (result.rowCount > 0) {
        const row = result.rows[0];
        console.log(`Apollo phone webhook: updated ${row.full_name} (${row.email}) → ${phone}`);
        totalUpdated += result.rowCount;
      } else {
        console.warn('Apollo phone webhook: UNMATCHED', { apolloId, phone });
      }
    }

    res.json({ received: true, updated: totalUpdated });
  } catch (err) {
    console.error('Apollo phone webhook error:', err.message);
    res.json({ received: true, error: err.message });
  }
});

module.exports = router;
