/**
 * debug-log.js — Buffered event logger for production debug mode.
 *
 * Gated on process.env.DEBUG === '1'. When off, logEvent() is a no-op.
 * When on, events are buffered and batch-INSERTed every 2 seconds.
 * On INSERT failure: console.warn + drop buffer (no retry, no growth).
 */

const { pool } = require('../db');

const FLUSH_INTERVAL_MS = 2000;
let buffer = [];
let flushTimer = null;

function logEvent(category, source, summary, opts = {}) {
  if (process.env.DEBUG !== '1') return;
  buffer.push({
    category,
    source,
    level: opts.level || 'info',
    summary,
    detail: opts.detail || null,
    call_id: opts.callId || null,
    caller_identity: opts.caller || null,
  });
  if (!flushTimer) {
    flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
    flushTimer.unref();
  }
}

async function flushBuffer() {
  flushTimer = null;
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];

  // Build multi-row INSERT
  const values = [];
  const params = [];
  for (let i = 0; i < batch.length; i++) {
    const e = batch[i];
    const off = i * 7;
    values.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7})`);
    params.push(e.category, e.source, e.level, e.summary, JSON.stringify(e.detail), e.call_id, e.caller_identity);
  }

  try {
    await pool.query(
      `INSERT INTO debug_events (category, source, level, summary, detail, call_id, caller_identity)
       VALUES ${values.join(', ')}`,
      params,
    );
  } catch (err) {
    console.warn('debug-log: batch INSERT failed, dropping', batch.length, 'events:', err.message);
  }
}

/** Flush remaining buffer. Call from SIGTERM handler. */
async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();
}

module.exports = { logEvent, flush };
