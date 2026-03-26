const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { sendSlackAlert, formatCallAlert } = require('../lib/slack');
const { addNoteToContact } = require('../lib/hubspot');

const router = Router();

// GET /api/history — list past calls
router.get('/', apiKeyAuth, async (req, res) => {
  const { caller, disposition, limit = 25, offset = 0 } = req.query;

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

  params.push(parseInt(limit, 10));
  params.push(parseInt(offset, 10));

  try {
    const result = await pool.query(
      `SELECT * FROM nucleus_phone_calls
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM nucleus_phone_calls WHERE ${where.join(' AND ')}`,
      params.slice(0, -2)
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
  try {
    const result = await pool.query(
      'SELECT * FROM nucleus_phone_calls WHERE id = $1',
      [req.params.id]
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
  const { disposition, qualification, notes, products_discussed, callbackRequested } = req.body;

  if (!disposition) {
    return res.status(400).json({ error: 'disposition required' });
  }

  try {
    const result = await pool.query(
      `UPDATE nucleus_phone_calls
       SET disposition = $1, qualification = $2, notes = $3,
           products_discussed = $4
       WHERE id = $5
       RETURNING *`,
      [
        disposition,
        qualification || null,
        notes || null,
        JSON.stringify(products_discussed || []),
        req.params.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const call = result.rows[0];

    // Slack alert for hot/warm leads
    if (qualification === 'hot' || qualification === 'warm') {
      const alert = formatCallAlert({
        disposition, qualification, notes,
        leadName: call.lead_name,
        leadCompany: call.lead_company,
        callerIdentity: call.caller_identity,
        durationSeconds: call.duration_seconds,
        productsDiscussed: products_discussed,
      });

      sendSlackAlert(alert).then((sent) => {
        if (sent) {
          pool.query('UPDATE nucleus_phone_calls SET slack_notified = TRUE WHERE id = $1', [call.id]);
        }
      });
    }

    // Sync to HubSpot — add note to contact timeline
    if (call.hubspot_contact_id) {
      const noteBody = [
        `📞 Outbound call by ${call.caller_identity}`,
        `Duration: ${Math.floor((call.duration_seconds || 0) / 60)}:${((call.duration_seconds || 0) % 60).toString().padStart(2, '0')}`,
        `Disposition: ${disposition}${qualification ? ` (${qualification})` : ''}`,
        ...(products_discussed?.length ? [`Products: ${products_discussed.join(', ')}`] : []),
        ...(notes ? [`Notes: ${notes}`] : []),
      ].join('\n');

      addNoteToContact(call.hubspot_contact_id, noteBody)
        .then(() => {
          pool.query('UPDATE nucleus_phone_calls SET hubspot_synced = TRUE WHERE id = $1', [call.id]);
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
