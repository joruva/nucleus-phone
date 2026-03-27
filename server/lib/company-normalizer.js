/**
 * lib/company-normalizer.js — Company name normalization for matching.
 * Copied from joruva-v35-scripts/src/lib/company-normalizer.js.
 */

const COMPANY_SUFFIXES = /\b(inc\.?|incorporated|llc|l\.l\.c\.?|corp\.?|corporation|ltd\.?|limited|co\.?|company|group|lp|l\.p\.?|holdings|plc|gmbh|s\.a\.?|sa|ag)\s*$/i;
const WATERFALL_SUFFIXES = /\b(sarl|s\.?r\.?l\.?|pty|n\.?v\.?|b\.?v\.?|s\.?e\.?|oy|ab|a\.?s\.?|kft|ehf|d\.?o\.?o\.?|s\.?p\.?a\.?)\s*$/i;

function normalizeCompanyName(name) {
  if (!name) return '';
  let n = name.trim().toLowerCase();
  n = n.replace(/[,.\s]+$/, '');
  n = n.replace(COMPANY_SUFFIXES, '').trim();
  n = n.replace(/[,.\s]+$/, '');
  return n;
}

function normalizeForWaterfall(name) {
  if (!name) return '';

  let n = name;
  n = n.replace(/&amp;/gi, '&');
  n = n.replace(/&#39;/g, "'");
  n = n.replace(/&quot;/g, '"');
  n = n.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  n = n.replace(/\s+/g, ' ').trim();
  n = normalizeCompanyName(n);
  n = n.replace(/^the\s+/, '');

  for (let i = 0; i < 3; i++) {
    const before = n;
    n = n.replace(/[,.\s]+$/, '');
    n = n.replace(COMPANY_SUFFIXES, '').trim();
    n = n.replace(WATERFALL_SUFFIXES, '').trim();
    n = n.replace(/[,.\s]+$/, '');
    if (n === before) break;
  }

  return n.trim();
}

function generateVariants(name) {
  if (!name) return [];
  const base = normalizeForWaterfall(name);
  if (!base) return [];
  const variants = new Set([base]);
  if (base.includes('&')) {
    variants.add(base.replace(/\s*&\s*/g, ' and '));
  }
  if (base.includes(' and ')) {
    variants.add(base.replace(/ and /g, ' & '));
  }
  return [...variants];
}

module.exports = { normalizeCompanyName, normalizeForWaterfall, generateVariants };
