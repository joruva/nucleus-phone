const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { sendSlackAlert, formatCallAlert } = require('../lib/slack');
const { addNoteToContact } = require('../lib/hubspot');
const { formatDuration } = require('../lib/format');

const router = Router();

const CALL_COLUMNS = `id, created_at, conference_name, caller_identity, lead_phone,
  lead_name, lead_company, hubspot_contact_id, direction, status, duration_seconds,
  disposition, qualification, products_discussed, notes, recording_url,
  recording_duration, fireflies_uploaded`;

// GET /api/history — list past calls
router.get('/', apiKeyAuth, async (req, res) => {
  const { caller, disposition } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let where = ['status = \'completed\''];
  const params = [];
  let idx = 1;

  if (caller) {
    where.push(`caller_identity = $${idx++}`);
    params.push(caller);
  }
  if (disposition) {
    where.push(`disposition = $${idx++}`);
    params.push(disposition);
  }

  const whereClause = where.join(' AND ');

  try {
    const result = await pool.query(
      `SELECT ${CALL_COLUMNS} FROM nucleus_phone_calls
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM nucleus_phone_calls WHERE ${whereClause}`,
      params
    );

    res.json({
      calls: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error('History fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/history/:id — single call detail
router.get('/:id', apiKeyAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  try {
    const result = await pool.query(
      `SELECT ${CALL_COLUMNS} FROM nucleus_phone_calls WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('History detail failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch call detail' });
  }
});

// POST /api/history/:id/disposition — set disposition + notes
router.post('/:id/disposition', apiKeyAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  const { disposition, qualification, notes, products_discussed } = req.body;

  if (!disposition) {
    return res.status(400).json({ error: 'disposition required' });
  }

  try {
    const result = await pool.query(
      `UPDATE nucleus_phone_calls
       SET disposition = $1, qualification = $2, notes = $3,
           products_discussed = $4
       WHERE id = $5
       RETURNING ${CALL_COLUMNS}`,
      [
        disposition,
        qualification || null,
        notes || null,
        JSON.stringify(products_discussed || []),
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const call = result.rows[0];

    // Slack alert for hot/warm leads (async, non-blocking)
    if (qualification === 'hot' || qualification === 'warm') {
      const alert = formatCallAlert({
        disposition, qualification, notes,
        leadName: call.lead_name,
        leadCompany: call.lead_company,
        callerIdentity: call.caller_identity,
        durationSeconds: call.duration_seconds,
        productsDiscussed: products_discussed,
      });

      sendSlackAlert(alert)
        .then((sent) => {
          if (sent) {
            pool.query('UPDATE nucleus_phone_calls SET slack_notified = TRUE WHERE id = $1', [call.id])
              .catch((err) => console.error('Failed to update slack_notified flag:', err.message));
          }
        })
        .catch((err) => console.error('Slack alert failed:', err.message));
    }

    // Sync to HubSpot — add note to contact timeline (async, non-blocking)
    if (call.hubspot_contact_id) {
      const noteBody = [
        `📞 Outbound call by ${call.caller_identity}`,
        `Duration: ${formatDuration(call.duration_seconds)}`,
        `Disposition: ${disposition}${qualification ? ` (${qualification})` : ''}`,
        ...(products_discussed?.length ? [`Products: ${products_discussed.join(', ')}`] : []),
        ...(notes ? [`Notes: ${notes}`] : []),
      ].join('\n');

      addNoteToContact(call.hubspot_contact_id, noteBody)
        .then(() => {
          pool.query('UPDATE nucleus_phone_calls SET hubspot_synced = TRUE WHERE id = $1', [call.id])
            .catch((err) => console.error('Failed to update hubspot_synced flag:', err.message));
        })
        .catch((err) => console.error('HubSpot sync failed:', err.message));
    }

    res.json(call);
  } catch (err) {
    console.error('Disposition save failed:', err.message);
    res.status(500).json({ error: 'Failed to save disposition' });
  }
});

module.exports = router;
