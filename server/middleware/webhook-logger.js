// TEMPORARY diagnostic middleware — REMOVE after webhook reliability is confirmed.
//
// Logs every inbound Twilio webhook request BEFORE signature validation.
// This lets us distinguish "callback never arrived" from "callback arrived
// but was rejected by twilio.webhook() middleware (403)".
function webhookLogger(req, res, next) {
  const ts = new Date().toISOString();
  const event = req.body?.StatusCallbackEvent || req.body?.RecordingStatus || 'voice';
  const conf = req.body?.FriendlyName || req.body?.ConferenceName || '-';
  console.log(
    `[webhook-in] ${ts} ${req.method} ${req.originalUrl} event=${event} conf=${conf} ip=${req.ip}`
  );

  // Listen for the response finish event to detect 403 rejections.
  // This avoids monkey-patching res.send/json/sendStatus which is fragile
  // and breaks if downstream middleware calls them multiple times.
  res.on('finish', () => {
    if (res.statusCode === 403) {
      console.warn(`[webhook-in] REJECTED (403) ${req.originalUrl} event=${event} conf=${conf}`);
    }
  });

  next();
}

module.exports = { webhookLogger };
