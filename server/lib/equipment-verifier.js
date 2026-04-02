/**
 * equipment-verifier.js — Autonomous spec verification against manufacturer data.
 *
 * Uses Claude web search to cross-reference CFM/PSI/HP values for catalog entries
 * against trusted sources (manufacturer spec sheets, dealer listings).
 * Flags discrepancies, updates confidence levels, and logs results.
 *
 * Designed to run as a scheduled job — not in the hot path.
 */

const { pool } = require('../db');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const VERIFY_TIMEOUT = 45000; // 45s — web search can take 15-25s, generous for background job
const BATCH_DELAY = 2000;     // 2s between verifications to be polite to Claude API

// ── Trusted Source Allowlist ────────────────────────────────────────
// Auto-corrections ONLY apply when the source URL matches one of these
// domains. Everything else gets flagged but not auto-applied.
// Add domains here as new manufacturers or authoritative sources emerge.
const TRUSTED_DOMAINS = [
  // OEM manufacturer sites
  'haascnc.com',
  'mazakusa.com',
  'us.dmgmori.com', 'dmgmori.com',
  'doosanmachinetools.com', 'dn-solutions.com',  // Doosan rebranded to DN Solutions
  'fanuc.co.jp', 'fanucamerica.com',
  'hurco.com',
  'kitamura-machinery.com',
  'okuma.com',
  'brother.co.jp', 'brother-usa.com',
  'makino.com',
  'biesse.com',
  'thermwood.com',
  'shopbottools.com',
  'lagunatools.com',
  'satausa.com', 'sata.com',
  'devilbissautorefinish.com',
  'anest-iwata.com', 'iwata-airbrush.com',
  'dynabrade.com',
  'clemcoindustries.com',
  'schmidtblasting.com',
  'pearsonpkg.com',
  'wexxar.com',
  'signode.com',
  'lantech.com',
  'loveshaw.com',

  // Authoritative industrial references
  'practicalmachinist.com',      // largest machinist forum — spec threads are reliable
  'cnczone.com',                 // CNC community with verified spec data
  'mmsonline.com',               // Modern Machine Shop — trade publication
  'americanmachinist.com',       // industry trade journal
  'productionmachining.com',     // trade publication
  'thomasnet.com',               // industrial equipment directory
  'machinetools.com',            // used machine spec database
  'grizzly.com',                 // OEM for Grizzly machines
];

const VERIFY_SYSTEM_PROMPT = `You are an industrial equipment verification specialist. Given a manufacturer, model, and our current specs, search for the ACTUAL compressed air requirements from manufacturer documentation, dealer listings, or technical manuals.

Compare our specs against what you find and return ONLY valid JSON:
{
  "verified": true/false,
  "source_url": "URL of the most authoritative source found" or null,
  "source_type": "manufacturer_spec_sheet"|"dealer_listing"|"tech_manual"|"forum"|"estimated",
  "findings": {
    "cfm_min": { "ours": number, "theirs": number or null, "match": true/false },
    "cfm_max": { "ours": number, "theirs": number or null, "match": true/false },
    "cfm_typical": { "ours": number, "theirs": number or null, "match": true/false },
    "psi_required": { "ours": number, "theirs": number or null, "match": true/false },
    "power_hp": { "ours": number, "theirs": number or null, "match": true/false }
  },
  "discrepancies": ["human-readable description of each mismatch"],
  "suggested_corrections": {
    "cfm_min": number or null,
    "cfm_max": number or null,
    "cfm_typical": number or null,
    "psi_required": number or null,
    "power_hp": number or null
  },
  "notes": "any relevant context about the verification"
}

Rules:
- "match" means within 20% of our value (air specs are inherently approximate).
- If you cannot find specs, set verified=false and explain in notes.
- STRONGLY prefer manufacturer documentation. Trusted domains in order of priority:
  1. Manufacturer websites (haascnc.com, mazakusa.com, makino.com, etc.)
  2. Trade publications (mmsonline.com, americanmachinist.com, productionmachining.com)
  3. Industrial directories (thomasnet.com, machinetools.com)
  4. Expert forums (practicalmachinist.com, cnczone.com)
- For spray guns, CFM is measured "at the cap" — make sure you're comparing the right measurement.
- For CNC machines, air demand includes tool change, chip blow-off, and pneumatic fixtures.
- Include the FULL source URL so we can verify the domain.`;

/**
 * Verify a single catalog entry against web sources.
 * Returns verification result or null on failure.
 */
async function verifyEntry(entry) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: VERIFY_SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{
          role: 'user',
          content: `Verify compressed air specs for: ${entry.manufacturer} ${entry.model}

Our current data:
- CFM range: ${entry.cfm_min} - ${entry.cfm_max} (typical: ${entry.cfm_typical})
- PSI required: ${entry.psi_required}
- Power: ${entry.power_hp || 'unknown'} HP
- Category: ${entry.category} / ${entry.subcategory}
- Air quality class: ${entry.air_quality_class}`,
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`verifier: Claude API ${res.status}: ${body.substring(0, 200)}`);
      return null;
    }

    const result = await res.json();
    const textBlock = result.content?.find(b => b.type === 'text');
    if (!textBlock?.text) return null;

    // Extract JSON from response — Claude may wrap it in markdown
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`verifier: timeout for ${entry.manufacturer} ${entry.model}`);
    } else {
      console.error(`verifier: failed for ${entry.manufacturer} ${entry.model}:`, err.message);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if a source URL belongs to a trusted domain.
 */
function isSourceTrusted(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return TRUSTED_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

/**
 * Apply verified corrections to a catalog entry.
 * Only updates fields where the verification found a discrepancy
 * AND the source URL belongs to a TRUSTED_DOMAINS domain.
 * Untrusted sources are logged but never auto-applied.
 */
async function applyCorrections(entryId, verification) {
  if (!verification.verified) return false;

  // Hard constraint: source must be on the allowlist
  if (!isSourceTrusted(verification.source_url)) {
    console.log(`verifier: source not trusted for id=${entryId}: ${verification.source_url} — skipping auto-correct`);
    return false;
  }

  // Map of LLM field names → actual DB column names.
  // Column names are hardcoded here — never derived from external input.
  const ALLOWED_CORRECTIONS = new Map([
    ['cfm_min', 'cfm_min'],
    ['cfm_max', 'cfm_max'],
    ['cfm_typical', 'cfm_typical'],
    ['psi_required', 'psi_required'],
    ['power_hp', 'power_hp'],
  ]);

  const corrections = verification.suggested_corrections || {};
  const updates = [];
  const values = [];
  let paramIdx = 1;

  for (const [field, value] of Object.entries(corrections)) {
    if (value == null) continue;
    const column = ALLOWED_CORRECTIONS.get(field);
    if (!column) continue;
    updates.push(`${column} = $${paramIdx}`);
    values.push(value);
    paramIdx++;
  }

  if (updates.length === 0) return false;

  // Bump confidence and record the actual source type
  updates.push(`confidence = 'high'`);
  const sourceLabel = verification.source_type || 'verified';
  updates.push(`source = $${paramIdx}`);
  values.push(sourceLabel);
  paramIdx++;
  if (verification.source_url) {
    updates.push(`source_url = $${paramIdx}`);
    values.push(verification.source_url);
    paramIdx++;
  }
  updates.push(`last_verified_at = NOW()`);
  updates.push(`verified_by = 'auto_verifier'`);
  updates.push(`updated_at = NOW()`);

  values.push(entryId);

  try {
    await pool.query(
      `UPDATE equipment_catalog SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );
    return true;
  } catch (err) {
    console.error(`verifier: failed to apply corrections for id=${entryId}:`, err.message);
    return false;
  }
}

/**
 * Verify entries that haven't been verified recently.
 * Returns a summary of findings.
 *
 * @param {Object} opts
 * @param {number} opts.staleDays   - Consider entries stale after this many days (default: 30)
 * @param {number} opts.batchSize   - Max entries to verify per run (default: 10)
 * @param {boolean} opts.autoCorrect - Apply corrections from authoritative sources (default: false)
 */
async function verifyStaleEntries({ staleDays = 30, batchSize = 10, autoCorrect = false } = {}) {
  const { rows: stale } = await pool.query(
    `SELECT * FROM equipment_catalog
     WHERE last_verified_at IS NULL
        OR last_verified_at < NOW() - INTERVAL '1 day' * $1
     ORDER BY
       last_verified_at ASC NULLS FIRST,
       confidence ASC
     LIMIT $2`,
    [staleDays, batchSize]
  );

  if (stale.length === 0) return { verified: 0, discrepancies: 0, corrected: 0, results: [] };

  const results = [];
  let discrepancies = 0;
  let corrected = 0;

  for (const entry of stale) {
    const verification = await verifyEntry(entry);

    if (!verification) {
      results.push({ id: entry.id, manufacturer: entry.manufacturer, model: entry.model, status: 'failed' });
      await delay(BATCH_DELAY);
      continue;
    }

    const hasDiscrepancy = verification.discrepancies?.length > 0;
    if (hasDiscrepancy) discrepancies++;

    // Even if no corrections, mark as verified if specs confirmed
    if (verification.verified && !hasDiscrepancy) {
      await pool.query(
        `UPDATE equipment_catalog SET last_verified_at = NOW(), verified_by = 'auto_verifier', updated_at = NOW() WHERE id = $1`,
        [entry.id]
      );
    }

    if (hasDiscrepancy && autoCorrect) {
      const applied = await applyCorrections(entry.id, verification);
      if (applied) corrected++;
    }

    results.push({
      id: entry.id,
      manufacturer: entry.manufacturer,
      model: entry.model,
      status: hasDiscrepancy ? 'discrepancy' : 'confirmed',
      discrepancies: verification.discrepancies || [],
      source: verification.source_url,
      sourceType: verification.source_type,
      sourceTrusted: isSourceTrusted(verification.source_url),
    });

    await delay(BATCH_DELAY);
  }

  return { verified: results.length, discrepancies, corrected, results };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { verifyEntry, verifyStaleEntries, applyCorrections, isSourceTrusted, TRUSTED_DOMAINS };
