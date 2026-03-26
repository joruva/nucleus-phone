const { Router } = require('express');
const { generateAccessToken } = require('../lib/twilio');

const router = Router();

router.get('/', (req, res) => {
  const { identity } = req.query;
  if (!identity) {
    return res.status(400).json({ error: 'identity query param required' });
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
