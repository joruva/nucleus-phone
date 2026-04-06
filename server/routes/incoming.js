/**
 * incoming.js — Handles inbound calls to the Nucleus Phone number.
 *
 * Routes inbound calls through the same conference architecture as outbound
 * calls so they get recording, RT transcription, Fireflies upload, equipment
 * detection, AI summary, and UCIL sync — the full Nucleus flywheel.
 *
 * Flow:
 *   1. Caller dials (602) 600-0188
 *   2. Twilio hits POST /api/voice/incoming
 *   3. We create a DB row + in-memory conference state
 *   4. TwiML puts the caller into a conference with recording + RT transcription
 *   5. Status callback (existing /api/call/status) dials the rep into the conference
 *   6. From here on, identical to outbound: recording → Fireflies, transcription → pipeline
 *
 * Config: INBOUND_FORWARD_NUMBER env var (E.164 format).
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const { VoiceResponse } = require('../lib/twilio');
const { pool } = require('../db');
const { createConference } = require('../lib/conference');
const { sendSlackAlert } = require('../lib/slack');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming`,
});

router.post('/', twilioWebhook, async (req, res) => {
  const forwardTo = process.env.INBOUND_FORWARD_NUMBER;
  const twiml = new VoiceResponse();

  if (!forwardTo) {
    console.error('incoming: INBOUND_FORWARD_NUMBER not set');
    twiml.say('Thank you for calling Joruva. We are currently unavailable. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  const callerPhone = req.body.From || 'unknown';
  const callerCallSid = req.body.CallSid;
  const conferenceName = `nucleus-inbound-${uuidv4()}`;

  console.log(`incoming: ${callerPhone} → conference ${conferenceName} → dial ${forwardTo}`);

  // Create DB row — same schema as outbound, but direction='inbound' and
  // lead_phone stores the CALLER's number (for identity resolution).
  let dbRowId;
  try {
    const result = await pool.query(
      `INSERT INTO nucleus_phone_calls
        (conference_name, caller_identity, caller_call_sid, lead_phone, direction)
       VALUES ($1, $2, $3, $4, 'inbound')
       RETURNING id`,
      [conferenceName, 'inbound', callerCallSid, callerPhone]
    );
    dbRowId = result.rows[0].id;
  } catch (err) {
    console.error('incoming: DB insert failed:', err.message);
    twiml.say('Thank you for calling Joruva. We are experiencing technical difficulties. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Create in-memory conference state.
  // leadPhone = the rep's number (who gets dialed INTO the conference).
  // The status callback at /api/call/status reads conf.leadPhone to know
  // who to dial on conference-start.
  createConference(conferenceName, {
    callerIdentity: 'inbound',
    to: forwardTo,
    contactName: callerPhone,
    companyName: null,
    contactId: null,
    dbRowId,
  });

  // Enable RT transcription (same as outbound voice.js)
  const start = twiml.start();
  start.transcription({
    statusCallbackUrl: `${baseUrl}/api/transcription`,
    statusCallbackMethod: 'POST',
    track: 'both_tracks',
    languageCode: 'en-US',
    partialResults: true,
    intelligenceService: process.env.TWILIO_INTELLIGENCE_SERVICE_SID || undefined,
  });

  // Put the inbound caller into a conference with recording.
  // startConferenceOnEnter=true → conference starts when caller joins.
  // Status callback will fire conference-start → dials the rep in.
  const dial = twiml.dial({ callerId: callerPhone });
  dial.conference({
    record: 'record-from-start',
    recordingStatusCallback: `${baseUrl}/api/call/recording-status`,
    recordingStatusCallbackEvent: 'completed',
    statusCallback: `${baseUrl}/api/call/status`,
    statusCallbackEvent: 'start end join leave',
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    beep: false,
  }, conferenceName);

  // Slack notification for inbound call
  sendSlackAlert({
    text: `:telephone_receiver: Inbound call from ${callerPhone} — forwarding to rep`,
  }).catch(() => {});

  res.type('text/xml').send(twiml.toString());
});

// POST /api/voice/incoming/fallback — if the rep doesn't answer,
// the caller stays in a silent conference. The conference-end callback
// handles cleanup. For voicemail, we'd need to detect no-answer and
// redirect — but the current status callback dial has earlyMedia +
// endConferenceOnExit, so if the rep rejects/times out, the conference
// ends and the caller is disconnected.
//
// Future enhancement: add a timeout monitor that plays a voicemail prompt
// if the rep hasn't joined within 30 seconds.

module.exports = router;
