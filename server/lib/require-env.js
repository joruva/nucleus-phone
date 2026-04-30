// Boot pre-flight: assert required env vars are set before the HTTP server
// starts accepting traffic. Refusing to start beats serving cold-start 4xx/5xx
// from a misconfigured deploy — Render shows "failed to start" instead of
// silently 500-ing in production. (joruva-dialer-mac-wby — three M1 env vars
// shipped without checks, masked for ~5 days by 30-day session-cookie cache.)
function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length === 0) return;

  for (const k of missing) console.error(`[boot] missing required env var: ${k}`);
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

module.exports = { requireEnv };
