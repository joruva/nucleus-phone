const { Router } = require('express');
const { generateAccessToken } = require('../lib/twilio');

const router = Router();

router.get('/', (req, res) => {
  // Use identity from session (set by auth middleware), not from query param.
  // API key users (programmatic) can still pass identity as query param.
  const identity = req.user?.identity || req.query.identity;
  if (!identity) {
    return res.status(400).json({ error: 'identity required' });
  }

  try {
    const token = generateAccessToken(identity);
    res.json({ token, identity });
  } catch (err) {
    console.error('Token generation failed:', err);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

module.exports = router;
