const { Router } = require('express');
const twilio = require('twilio');
const { client, VoiceResponse } = require('../lib/twilio');
const { getConference, updateConference } = require('../lib/conference');

const router = Router();

// Twilio request validation middleware
const twilioWebhook = twilio.webhook({ validate: process.env.NODE_ENV === 'production' });

// POST /api/voice — TwiML webhook called by Twilio when PWA connects via Voice SDK
router.post('/', twilioWebhook, async (req, res) => {
  const { To, ConferenceName, CallerIdentity, Action, Muted } = req.body;
  const twiml = new VoiceResponse();

  if (Action === 'join') {
    // Tom (or another admin) joining an existing conference
    const dial = twiml.dial();
    dial.conference({
      startConferenceOnEnter: false,
      endConferenceOnExit: false,
      muted: Muted === 'true',
      beep: false,
    }, ConferenceName);

    return res.type('text/xml').send(twiml.toString());
  }

  // Default: "initiate" — caller enters conference, then we dial the lead
  const dial = twiml.dial({ callerId: process.env.NUCLEUS_PHONE_NUMBER });
  dial.conference({
    record: 'record-from-start',
    recordingStatusCallback: '/api/call/recording-status',
    recordingStatusCallbackEvent: 'completed',
    statusCallback: '/api/call/status',
    statusCallbackEvent: 'start end join leave',
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    beep: false,
  }, ConferenceName);

  res.type('text/xml').send(twiml.toString());

  // After responding with TwiML, dial the lead into the conference.
  // We do this asynchronously — the TwiML response already put the caller in.
  if (To && ConferenceName) {
    try {
      // Small delay to let the conference spin up
      await new Promise((r) => setTimeout(r, 500));

      // Find the conference SID
      const conferences = await client.conferences.list({
        friendlyName: ConferenceName,
        status: 'in-progress',
        limit: 1,
      });

      if (conferences.length === 0) {
        console.error(`Conference ${ConferenceName} not found after creation`);
        return;
      }

      const conferenceSid = conferences[0].sid;
      updateConference(ConferenceName, { conferenceSid });

      // Add the lead as a participant
      await client.conferences(conferenceSid).participants.create({
        from: process.env.NUCLEUS_PHONE_NUMBER,
        to: To,
        earlyMedia: true,
        beep: false,
        endConferenceOnExit: true, // When lead hangs up, end conference
      });

      console.log(`Dialed ${To} into conference ${ConferenceName}`);
    } catch (err) {
      console.error('Failed to dial lead into conference:', err.message);
    }
  }
});

module.exports = router;
