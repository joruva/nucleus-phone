/**
 * main-line.js — IVR menu for the toll-free Joruva Industrial line.
 *
 * Wired to +18447132636 (the public number on the website + business plan).
 * Default audience is compressed-air customers reaching the Vapi AI
 * receptionist (Eryn / Jack John / Dexter). The IVR adds a press-2 branch
 * for investors reading the 3-page business plan.
 *
 *   Press 2          → investor relations (rings Tom's cell, no recording)
 *   No input / else  → Vapi AI receptionist (existing customer-service flow)
 *
 * Per-rep direct DIDs and the Phoenix line (+16026000188) are untouched —
 * their Twilio voice URLs still point to /api/voice/incoming directly.
 */

const { Router } = require('express');
const twilio = require('twilio');
const { VoiceResponse } = require('../lib/twilio');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const vapiFallbackUrl = process.env.VAPI_INBOUND_URL || 'https://api.vapi.ai/twilio/inbound_call';

function makeTwilioWebhook(path) {
  return twilio.webhook({
    validate: process.env.NODE_ENV === 'production',
    url: `${baseUrl}${path}`,
  });
}

// ─── POST / — IVR menu prompt ────────────────────────────────────────

router.post('/', makeTwilioWebhook('/api/voice/main'), (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    timeout: 4,
    action: `${baseUrl}/api/voice/main/menu`,
    method: 'POST',
  });

  gather.say({
    voice: 'Polly.Joanna-Generative',
  }, 'Thanks for calling <phoneme alphabet="ipa" ph="ˈdʒoʊruːvə">Joruva</phoneme> Industrial. Press 1 for sales, press 2 for investor relations, or stay on the line.');

  // No input → fall through to the Vapi AI receptionist (existing flow).
  twiml.redirect({ method: 'POST' }, vapiFallbackUrl);

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /menu — Handle digit press ─────────────────────────────────

router.post('/menu', makeTwilioWebhook('/api/voice/main/menu'), (req, res) => {
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  if (digit === '2') {
    twiml.redirect({ method: 'POST' }, `${baseUrl}/api/voice/investor`);
  } else if (digit === '1') {
    // Sales — fall into the per-DID INBOUND_ROUTES flow (toll-free → Alex).
    twiml.redirect({ method: 'POST' }, `${baseUrl}/api/voice/incoming`);
  } else {
    // Anything else → Vapi AI receptionist (existing customer-service flow).
    twiml.redirect({ method: 'POST' }, vapiFallbackUrl);
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
