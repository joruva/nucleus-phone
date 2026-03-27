/**
 * lib/phone.js — Shared phone normalization utility.
 * Copied from joruva-ucil/src/lib/phone.js.
 */

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  // Strip extension: ext/ext. and # (with or without whitespace — #200 is standard extension notation),
  // but bare "x" requires preceding whitespace to avoid stripping truncated data like "8005551234x".
  const base = phone.replace(/\s*(ext\.?\s*|#)\s*\d+$/i, '').replace(/\s+x\s*\d+$/i, '');
  const digits = base.replace(/\D/g, '');
  if (digits.length < 7) return null;
  // Strip leading 1 for US numbers (11 digits starting with 1)
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
}

module.exports = { normalizePhone };
