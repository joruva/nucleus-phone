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

// POST /api/voice/incoming/rep-status — Twilio calls this when the rep's
// participant leg changes state. If the rep doesn't answer, redirect the
// caller out of the conference and into voicemail.
const repStatusWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming/rep-status`,
});

router.post('/rep-status', repStatusWebhook, async (req, res) => {
  res.sendStatus(204);

  const { CallStatus } = req.body;
  const conferenceName = req.query.conf;
  if (!conferenceName) return;

  const noAnswer = ['no-answer', 'busy', 'canceled', 'failed'].includes(CallStatus);
  if (!noAnswer) return;

  console.log(`incoming: rep did not answer (${CallStatus}) for ${conferenceName} — redirecting to voicemail`);

  // Look up the caller's CallSid so we can redirect their leg
  try {
    const { rows } = await pool.query(
      'SELECT caller_call_sid FROM nucleus_phone_calls WHERE conference_name = $1',
      [conferenceName]
    );
    const callerSid = rows[0]?.caller_call_sid;
    if (!callerSid) {
      console.error('incoming: no caller_call_sid for voicemail redirect');
      return;
    }

    // Redirect the caller's call leg to voicemail TwiML
    const { client } = require('../lib/twilio');
    await client.calls(callerSid).update({
      url: `${baseUrl}/api/voice/incoming/voicemail`,
      method: 'POST',
    });

    console.log(`incoming: redirected ${callerSid} to voicemail`);
  } catch (err) {
    console.error('incoming: voicemail redirect failed:', err.message);
  }
});

// POST /api/voice/incoming/voicemail — TwiML that plays a message and records.
// The caller lands here when redirected out of the conference.
const voicemailWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming/voicemail`,
});

router.post('/voicemail', voicemailWebhook, (req, res) => {
  const twiml = new VoiceResponse();

  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. No one is available to take your call right now. Please leave a message after the tone and we will get back to you as soon as possible.');

  twiml.record({
    maxLength: 180,
    playBeep: true,
    recordingStatusCallback: `${baseUrl}/api/voice/incoming/voicemail-complete`,
    recordingStatusCallbackEvent: 'completed',
    recordingStatusCallbackMethod: 'POST',
  });

  twiml.say('We did not receive a message. Goodbye.');

  res.type('text/xml').send(twiml.toString());
});

// POST /api/voice/incoming/voicemail-complete — saves voicemail recording URL to the call record
const vmCompleteWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming/voicemail-complete`,
});

router.post('/voicemail-complete', vmCompleteWebhook, async (req, res) => {
  res.sendStatus(204);

  const { RecordingUrl, RecordingSid, RecordingDuration, CallSid } = req.body;
  if (!RecordingUrl) return;

  console.log(`incoming: voicemail recorded (${RecordingDuration}s) — ${RecordingSid}`);

  try {
    await pool.query(
      `UPDATE nucleus_phone_calls
       SET recording_url = $1, status = 'voicemail'
       WHERE caller_call_sid = $2`,
      [RecordingUrl, CallSid]
    );

    // Notify via Slack
    sendSlackAlert({
      text: `:mailbox_with_mail: Voicemail received (${RecordingDuration}s) — check call history for recording`,
    }).catch(() => {});
  } catch (err) {
    console.error('incoming: voicemail save failed:', err.message);
  }
});

module.exports = router;
