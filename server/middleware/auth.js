const jwt = require('jsonwebtoken');

// Session-based auth via cookie (primary — used by browser)
function sessionAuth(req, res, next) {
  const token = req.cookies?.nucleus_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { identity: payload.identity, role: payload.role, email: payload.email };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
}

// Accepts API key OR session cookie. If an API key header is present,
// it must be correct — a wrong key is a 401, not a silent fallback.
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];

  if (key) {
    if (key === process.env.NUCLEUS_PHONE_API_KEY) return next();
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // No API key header — try session cookie
  return sessionAuth(req, res, next);
}

module.exports = { apiKeyAuth, sessionAuth };
