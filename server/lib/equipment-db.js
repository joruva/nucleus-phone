/**
 * equipment-db.js — Equipment Knowledge Base CRUD + fuzzy matching.
 *
 * All queries use LEFT JOIN on equipment_details since details may be
 * null for newly auto-inserted catalog entries.
 */

const { pool } = require('../db');

const FUZZY_MAX_DISTANCE = 2;

// Inline Levenshtein for JS fallback when fuzzystrmatch is unavailable.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

const CATALOG_DETAILS_JOIN = `
  SELECT ec.*, ed.description, ed.typical_applications, ed.industries,
         ed.air_usage_notes, ed.common_air_problems, ed.recommended_air_quality,
         ed.recommended_compressor, ed.recommended_dryer, ed.recommended_filters,
         ed.system_notes
  FROM equipment_catalog ec
  LEFT JOIN equipment_details ed ON ed.equipment_id = ec.id
`;

/**
 * Exact match on manufacturer + model (case-insensitive).
 */
async function findByManufacturerModel(mfg, model) {
  try {
    const { rows } = await pool.query(
      `${CATALOG_DETAILS_JOIN} WHERE LOWER(ec.manufacturer) = LOWER($1) AND LOWER(ec.model) = LOWER($2)`,
      [mfg, model]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('equipment-db findByManufacturerModel error:', err.message);
    return null;
  }
}

/**
 * Search model_variants array for alternate spellings (STT garbling).
 */
async function findByVariant(mfg, modelVariant) {
  try {
    const { rows } = await pool.query(
      `${CATALOG_DETAILS_JOIN}
       WHERE LOWER(ec.manufacturer) = LOWER($1)
         AND EXISTS (SELECT 1 FROM unnest(ec.model_variants) v WHERE LOWER(v) = LOWER($2))`,
      [mfg, modelVariant]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('equipment-db findByVariant error:', err.message);
    return null;
  }
}

/**
 * Fuzzy match using Levenshtein distance <= 2.
 * Uses fuzzystrmatch extension if available, otherwise JS fallback
 * on prefix-matched candidates.
 */
async function findFuzzy(mfg, model) {
  const db = require('../db');
  try {
    if (db.FUZZY_AVAILABLE) {
      const { rows } = await pool.query(
        `${CATALOG_DETAILS_JOIN}
         WHERE LOWER(ec.manufacturer) = LOWER($1)
           AND levenshtein(LOWER(ec.model), LOWER($2)) <= ${FUZZY_MAX_DISTANCE}
         ORDER BY levenshtein(LOWER(ec.model), LOWER($2))
         LIMIT 1`,
        [mfg, model]
      );
      return rows[0] || null;
    }

    // JS fallback: fetch prefix candidates, filter by Levenshtein in JS
    const prefix = model.substring(0, 3).toLowerCase();
    if (!prefix) return null;
    const { rows } = await pool.query(
      `${CATALOG_DETAILS_JOIN}
       WHERE LOWER(ec.manufacturer) = LOWER($1)
         AND LOWER(ec.model) LIKE $2`,
      [mfg, prefix + '%']
    );
    const target = model.toLowerCase();
    const match = rows
      .map(r => ({ ...r, dist: levenshtein(r.model.toLowerCase(), target) }))
      .filter(r => r.dist <= FUZZY_MAX_DISTANCE)
      .sort((a, b) => a.dist - b.dist)[0];
    return match || null;
  } catch (err) {
    console.error('equipment-db findFuzzy error:', err.message);
    return null;
  }
}

/**
 * Insert or update equipment catalog + details.
 * Returns the catalog row id, or { error: true, message } on failure.
 */
async function insertEquipment(catalogData, detailsData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [catalog] } = await client.query(
      `INSERT INTO equipment_catalog
        (manufacturer, model, model_variants, category, subcategory,
         cfm_min, cfm_max, cfm_typical, psi_required, duty_cycle_pct,
         air_quality_class, axis_count, power_hp, voltage,
         source, source_url, confidence, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (manufacturer, model) DO UPDATE SET
         model_variants = COALESCE(EXCLUDED.model_variants, equipment_catalog.model_variants),
         cfm_min = COALESCE(EXCLUDED.cfm_min, equipment_catalog.cfm_min),
         cfm_max = COALESCE(EXCLUDED.cfm_max, equipment_catalog.cfm_max),
         cfm_typical = COALESCE(EXCLUDED.cfm_typical, equipment_catalog.cfm_typical),
         psi_required = COALESCE(EXCLUDED.psi_required, equipment_catalog.psi_required),
         duty_cycle_pct = COALESCE(EXCLUDED.duty_cycle_pct, equipment_catalog.duty_cycle_pct),
         air_quality_class = COALESCE(EXCLUDED.air_quality_class, equipment_catalog.air_quality_class),
         source = EXCLUDED.source,
         source_url = EXCLUDED.source_url,
         confidence = EXCLUDED.confidence,
         updated_at = NOW()
       RETURNING id`,
      [
        catalogData.manufacturer, catalogData.model,
        catalogData.model_variants ?? null, catalogData.category,
        catalogData.subcategory ?? null,
        catalogData.cfm_min ?? null, catalogData.cfm_max ?? null,
        catalogData.cfm_typical ?? null, catalogData.psi_required ?? null,
        catalogData.duty_cycle_pct ?? null, catalogData.air_quality_class ?? null,
        catalogData.axis_count ?? null, catalogData.power_hp ?? null,
        catalogData.voltage ?? null, catalogData.source,
        catalogData.source_url ?? null, catalogData.confidence ?? 'medium',
        catalogData.verified_by ?? null,
      ]
    );

    if (detailsData) {
      await client.query(
        `INSERT INTO equipment_details
          (equipment_id, description, typical_applications, industries,
           air_usage_notes, common_air_problems, recommended_air_quality,
           recommended_compressor, recommended_dryer, recommended_filters,
           system_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (equipment_id) DO UPDATE SET
           description = COALESCE(EXCLUDED.description, equipment_details.description),
           typical_applications = COALESCE(EXCLUDED.typical_applications, equipment_details.typical_applications),
           industries = COALESCE(EXCLUDED.industries, equipment_details.industries),
           air_usage_notes = COALESCE(EXCLUDED.air_usage_notes, equipment_details.air_usage_notes),
           common_air_problems = COALESCE(EXCLUDED.common_air_problems, equipment_details.common_air_problems),
           recommended_air_quality = COALESCE(EXCLUDED.recommended_air_quality, equipment_details.recommended_air_quality),
           recommended_compressor = COALESCE(EXCLUDED.recommended_compressor, equipment_details.recommended_compressor),
           recommended_dryer = COALESCE(EXCLUDED.recommended_dryer, equipment_details.recommended_dryer),
           recommended_filters = COALESCE(EXCLUDED.recommended_filters, equipment_details.recommended_filters),
           system_notes = COALESCE(EXCLUDED.system_notes, equipment_details.system_notes)`,
        [
          catalog.id, detailsData.description ?? null,
          detailsData.typical_applications ?? null, detailsData.industries ?? null,
          detailsData.air_usage_notes ?? null, detailsData.common_air_problems ?? null,
          detailsData.recommended_air_quality ?? null, detailsData.recommended_compressor ?? null,
          detailsData.recommended_dryer ?? null, detailsData.recommended_filters ?? null,
          detailsData.system_notes ?? null,
        ]
      );
    }

    await client.query('COMMIT');
    return { id: catalog.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('equipment-db insertEquipment error:', err.message);
    return { error: true, message: err.message };
  } finally {
    client.release();
  }
}

/**
 * Log an equipment sighting from a call.
 */
/**
 * Log an equipment sighting from a call.
 * Returns true on success, false on failure.
 */
async function logSighting(data) {
  try {
    await pool.query(
      `INSERT INTO equipment_sightings
        (manufacturer, model, raw_mention, count, usage_pattern,
         call_type, call_id, caller_identity, contact_name, company_name,
         catalog_match_id, resolved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        data.manufacturer ?? null, data.model ?? null,
        data.raw_mention, data.count ?? 1, data.usage_pattern ?? null,
        data.call_type, data.call_id ?? null, data.caller_identity ?? null,
        data.contact_name ?? null, data.company_name ?? null,
        data.catalog_match_id ?? null, data.catalog_match_id ? true : false,
      ]
    );
    return true;
  } catch (err) {
    console.error('equipment-db logSighting error:', err.message);
    return false;
  }
}

module.exports = {
  findByManufacturerModel,
  findByVariant,
  findFuzzy,
  insertEquipment,
  logSighting,
  levenshtein, // exported for testing
};
