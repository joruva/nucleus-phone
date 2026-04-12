const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const { sync } = require('../lib/fireflies-sync');

const router = Router();

// POST /api/fireflies-sync — triggered by n8n cron every 30 min. Admin-only;
// n8n uses the API key which resolves to the synthetic admin principal.
router.post('/', apiKeyAuth, rbac('admin'), async (req, res) => {
  try {
    const result = await sync();
    res.json(result);
  } catch (err) {
    console.error('Fireflies sync endpoint failed:', err.message);
    res.status(500).json({ error: 'Sync failed', message: err.message });
  }
});

module.exports = router;
