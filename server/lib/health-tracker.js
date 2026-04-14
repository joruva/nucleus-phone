/**
 * health-tracker.js — In-memory last-seen tracker for integration health.
 *
 * Always on (not gated on DEBUG). Each integration calls touch() on
 * success; the debug health endpoint reads getAll() to show staleness.
 */

const lastSeen = new Map();

function touch(source) {
  lastSeen.set(source, Date.now());
}

function getAll() {
  const result = {};
  for (const [source, ts] of lastSeen) {
    result[source] = { lastSeen: ts, ageMinutes: Math.round((Date.now() - ts) / 60000) };
  }
  return result;
}

module.exports = { touch, getAll };
