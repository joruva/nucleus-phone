/**
 * lib/customer-lookup.js — Cross-channel identity resolution.
 * Pure query module — no writes. Returns aggregated customer history
 * from customer_interactions table.
 *
 * Copied from joruva-ucil/src/lib/customer-lookup.js.
 * Adapted: db.query -> pool.query.
 */

const { pool } = require('../db');
const { normalizePhone } = require('./phone');

const LOOKUP_COLS = `id, contact_id, channel, intent, disposition, summary, created_at,
  recording_url, products_discussed, sizing_data, qualification`;

const LOOKUP_LIMIT = 100;

async function lookupCustomer({ phone, email, contactId, company, name } = {}) {
  let rows = null;

  if (phone) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      const result = await pool.query(
        `SELECT ${LOOKUP_COLS} FROM customer_interactions WHERE phone = $1 ORDER BY created_at DESC LIMIT ${LOOKUP_LIMIT}`,
        [normalized]
      );
      if (result.rows.length) rows = result.rows;
    }
  }

  if (!rows && email) {
    const result = await pool.query(
      `SELECT ${LOOKUP_COLS} FROM customer_interactions WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT ${LOOKUP_LIMIT}`,
      [email]
    );
    if (result.rows.length) rows = result.rows;
  }

  if (!rows && contactId) {
    const result = await pool.query(
      `SELECT ${LOOKUP_COLS} FROM customer_interactions WHERE contact_id = $1 ORDER BY created_at DESC LIMIT ${LOOKUP_LIMIT}`,
      [contactId]
    );
    if (result.rows.length) rows = result.rows;
  }

  if (!rows && company && name) {
    const result = await pool.query(
      `SELECT ${LOOKUP_COLS} FROM customer_interactions WHERE LOWER(company_name) = LOWER($1) AND LOWER(contact_name) = LOWER($2) ORDER BY created_at DESC LIMIT ${LOOKUP_LIMIT}`,
      [company, name]
    );
    if (result.rows.length) rows = result.rows;
  }

  if (!rows) return null;

  return aggregate(rows);
}

function aggregate(rows) {
  const productSet = new Set();
  for (const row of rows) {
    const products = row.products_discussed;
    if (Array.isArray(products)) {
      for (const p of products) productSet.add(p);
    }
  }

  let latestSizingData = {};
  for (const row of rows) {
    const sizing = row.sizing_data;
    if (sizing && typeof sizing === 'object' && Object.keys(sizing).length > 0) {
      latestSizingData = sizing;
      break;
    }
  }

  let highestQualification = null;
  let maxScore = -1;
  for (const row of rows) {
    const qual = row.qualification;
    if (qual && typeof qual === 'object') {
      const score = parseInt(qual.score, 10);
      if (!isNaN(score) && score > maxScore) {
        maxScore = score;
        highestQualification = {
          interactionId: row.id,
          score,
          stage: qual.stage || null,
          reason: qual.reason || null,
        };
      }
    }
  }

  const interactions = rows.map(row => ({
    id: row.id,
    channel: row.channel,
    intent: row.intent,
    disposition: row.disposition,
    summary: row.summary,
    createdAt: row.created_at,
    recordingUrl: row.recording_url,
  }));

  return {
    contactId: rows[0].contact_id || null,
    interactions,
    productsDiscussed: [...productSet],
    latestSizingData,
    highestQualification,
    lastInteractionSummary: rows[0].summary || null,
    interactionCount: rows.length,
    firstSeen: rows[rows.length - 1].created_at,
    lastSeen: rows[0].created_at,
  };
}

module.exports = { lookupCustomer, aggregate };
