/**
 * transcription.js — Twilio Real-Time Transcription webhook.
 *
 * Receives partial/final transcript chunks from Twilio RT Transcription,
 * accumulates them in the database, runs the equipment detection pipeline,
 * and broadcasts results to WebSocket subscribers.
 *
 * CallSid mapping: uses caller_call_sid (saved in voice.js) to look up the
 * call row. This avoids the race condition where conference_sid isn't yet
 * written when the first transcription chunk arrives.
 *
 * Twilio also sends TranscriptionEvent callbacks (transcription-started,
 * transcription-stopped) to this URL without TranscriptionText — the early
 * return on missing TranscriptionText handles these gracefully.
 */

const { Router } = require('express');
const twilio = require('twilio');
const { pool } = require('../db');
const { extractEquipment } = require('../lib/entity-extractor');
const { lookupEquipment } = require('../lib/equipment-lookup');
const { calculateDemand, recommendSystem } = require('../lib/sizing-engine');
const { logSighting } = require('../lib/equipment-db');
const { broadcast, getCallEquipment } = require('../lib/live-analysis');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/transcription`,
});

router.post('/', twilioWebhook, async (req, res) => {
  // Respond immediately — Twilio doesn't wait for processing
  res.sendStatus(204);

  const { TranscriptionText, Track, CallSid } = req.body;

  // Twilio sends status events (transcription-started/stopped) without text
  if (!TranscriptionText || !CallSid) return;

  // Look up call by caller_call_sid
  let call;
  try {
    const { rows } = await pool.query(
      'SELECT id, conference_name FROM nucleus_phone_calls WHERE caller_call_sid = $1',
      [CallSid]
    );
    call = rows[0];
  } catch (err) {
    console.error('transcription: call lookup failed:', err.message);
    return;
  }

  if (!call) {
    console.warn(`transcription: no call found for CallSid ${CallSid}`);
    return;
  }

  const callId = call.conference_name;

  // Accumulate transcript in DB
  try {
    await pool.query(
      `UPDATE nucleus_phone_calls
       SET transcript = COALESCE(transcript, '') || $1 || E'\\n'
       WHERE id = $2`,
      [TranscriptionText, call.id]
    );
  } catch (err) {
    console.error('transcription: transcript accumulation failed:', err.message);
  }

  // Broadcast raw transcript chunk
  broadcast(callId, {
    type: 'transcript_chunk',
    data: { text: TranscriptionText, speaker: Track || 'unknown' },
  });

  // Run entity extraction pipeline (fire-and-forget, don't block)
  processTranscriptChunk(call, callId, TranscriptionText).catch((err) => {
    console.error('transcription: pipeline error:', err.message);
  });
});

async function processTranscriptChunk(call, callId, text) {
  const entities = await extractEquipment(text);
  if (entities.length === 0) return;

  const accumulated = getCallEquipment(callId);

  for (const entity of entities) {
    // Look up specs in equipment catalog
    let result = null;
    if (entity.manufacturer && entity.model) {
      result = await lookupEquipment(entity.manufacturer, entity.model);
    }

    const specs = result ? {
      cfm_typical: result.cfm_typical,
      psi_required: result.psi_required,
      duty_cycle_pct: result.duty_cycle_pct,
      air_quality_class: result.air_quality_class,
      confidence: result.confidence,
    } : null;

    // Log sighting (await to avoid unhandled rejection)
    await logSighting({
      manufacturer: entity.manufacturer,
      model: entity.model,
      raw_mention: entity.raw_mention,
      count: entity.count,
      call_type: 'real',
      call_id: String(call.id),
      catalog_match_id: result?.id ?? null,
    });

    // Broadcast detection
    broadcast(callId, {
      type: 'equipment_detected',
      data: {
        manufacturer: entity.manufacturer,
        model: entity.model,
        count: entity.count,
        specs,
        catalogMatch: !!result,
      },
    });

    // Accumulate for sizing (cap at 100 to prevent pathological growth)
    const cfm = parseFloat(specs?.cfm_typical) || 0;
    if (cfm > 0 && accumulated.length < 100) {
      accumulated.push({
        cfm_typical: cfm,
        duty_cycle_pct: parseInt(specs.duty_cycle_pct, 10) || 50,
        psi_required: parseInt(specs.psi_required, 10) || 90,
        air_quality_class: specs.air_quality_class || 'general',
        count: entity.count,
      });
    }
  }

  // Recalculate sizing with all accumulated equipment
  if (accumulated.length > 0) {
    const demand = calculateDemand(accumulated);
    broadcast(callId, { type: 'sizing_updated', data: demand });

    const recommendation = recommendSystem(demand);
    if (recommendation) {
      broadcast(callId, { type: 'recommendation_ready', data: recommendation });
    }
  }
}

module.exports = router;
