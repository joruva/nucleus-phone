/**
 * lib/http-error.js — Shared helper for structured HTTP errors.
 *
 * Template established by lib/vapi.js. Attach status/body/endpoint/method as
 * properties (not just string-concatenated into err.message) so callers can
 * branch on err.status === 404 etc. without fragile message parsing.
 *
 * err.message is truncated (300 chars) because it ends up in logs.
 * err.body is the full response text for programmatic inspection.
 */

/**
 * Build and throw a structured HTTP error from a failed fetch response.
 *
 * @param {Response} res - The fetch Response (already confirmed !res.ok)
 * @param {string} text - The response body text (caller must have already awaited res.text())
 * @param {string} method - HTTP method (for err.message + err.method)
 * @param {string} endpoint - Endpoint path (for err.message + err.endpoint)
 * @param {Object} [opts]
 * @param {string} [opts.service] - Service name prefix for err.message (e.g., 'Apollo', 'Vapi')
 * @throws {Error} Always throws. Never returns.
 */
function throwHttpError(res, text, method, endpoint, { service = 'HTTP' } = {}) {
  const err = new Error(`${service} ${method} ${endpoint} (${res.status}): ${text.substring(0, 300)}`);
  err.status = res.status;
  err.body = text;
  err.endpoint = endpoint;
  err.method = method;
  throw err;
}

module.exports = { throwHttpError };
