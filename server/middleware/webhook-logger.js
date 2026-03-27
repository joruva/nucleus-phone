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

  // Capture whether the next middleware (twilio.webhook) rejects the request
  const origSend = res.send.bind(res);
  const origSendStatus = res.sendStatus.bind(res);
  const origJson = res.json.bind(res);

  function logOutcome(status) {
    if (status === 403) {
      console.warn(`[webhook-in] REJECTED (403) ${req.originalUrl} event=${event} conf=${conf}`);
    }
  }

  res.send = function (body) {
    logOutcome(res.statusCode);
    return origSend(body);
  };
  res.sendStatus = function (code) {
    logOutcome(code);
    return origSendStatus(code);
  };
  res.json = function (body) {
    logOutcome(res.statusCode);
    return origJson(body);
  };

  next();
}

module.exports = { webhookLogger };
