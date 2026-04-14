const { logEvent } = require('../lib/debug-log');

function errorHandler(err, req, res, _next) {
  console.error('Unhandled error:', err);
  logEvent('error', 'express.unhandled', `${err.name || 'Error'}: ${err.message}`, {
    level: 'error',
    detail: { url: req.originalUrl, method: req.method, stack: err.stack?.substring(0, 500) },
  });
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler };
