/**
 * incoming.js — Handles inbound calls to the Nucleus Phone number.
 *
 * Forwards inbound calls to a configured mobile number so reps can
 * give out the business number as a callback. Twilio webhook validation
 * ensures only Twilio can hit this endpoint.
 *
 * Config: INBOUND_FORWARD_NUMBER env var (E.164 format).
 */

const { Router } = require('express');
const twilio = require('twilio');
const { VoiceResponse } = require('../lib/twilio');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming`,
});

router.post('/', twilioWebhook, (req, res) => {
  const forwardTo = process.env.INBOUND_FORWARD_NUMBER;
  const twiml = new VoiceResponse();

  if (!forwardTo) {
    console.error('incoming: INBOUND_FORWARD_NUMBER not set');
    twiml.say('Thank you for calling Joruva. We are currently unavailable. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  const from = req.body.From || 'unknown';
  console.log(`incoming: forwarding call from ${from} to ${forwardTo}`);

  twiml.dial({
    callerId: process.env.NUCLEUS_PHONE_NUMBER,
    timeout: 25,
    action: `${baseUrl}/api/voice/incoming/status`,
  }, forwardTo);

  res.type('text/xml').send(twiml.toString());
});

// POST /api/voice/incoming/status — called after dial attempt completes
router.post('/status', twilioWebhook, (req, res) => {
  const { DialCallStatus } = req.body;
  const twiml = new VoiceResponse();

  if (DialCallStatus !== 'completed') {
    // Rep didn't answer — play a voicemail message
    twiml.say('Thank you for calling Joruva. No one is available to take your call right now. Please leave a message after the tone.');
    twiml.record({
      maxLength: 120,
      transcribe: true,
      playBeep: true,
    });
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
