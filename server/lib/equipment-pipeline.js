/**
 * equipment-pipeline.js — Shared entity extraction → lookup → sizing pipeline.
 *
 * Used by both Twilio RT transcription (real calls) and Vapi transcript events
 * (practice calls). Extracts equipment mentions, looks up specs, logs sightings,
 * broadcasts to WebSocket, and recalculates sizing recommendations.
 */

const { extractEquipment } = require('./entity-extractor');
const { lookupEquipment } = require('./equipment-lookup');
const { calculateDemand, recommendSystem, addQualityFilters, deriveSalesChannel } = require('./sizing-engine');
const { logSighting } = require('./equipment-db');
const { broadcast, getCallEquipment, resetCallEquipment, getCallAirQuality, setCallAirQuality } = require('./live-analysis');
const { addVariant } = require('./equipment-curator');
const { AQ_RANK } = require('./aq-constants');

// Proximity window for generic supersession (Approach B).
// Specific equipment mentions only consume generic entries added within this many
// processEquipmentChunk calls. At ~3-5s per chunk, 20 ≈ 60-100s of conversation.
const SUPERSEDE_WINDOW = 20;

// Per-call chunk counter for proximity-based supersession.
// Stores { count, ts } so cleanupPipelineState can sweep stale entries
// from calls that terminated abnormally (never hit the /status callback).
const chunkCounters = new Map();
const STALE_CALL_MS = 60 * 60 * 1000; // 1 hour

// Verbal reset trigger — rep says this phrase to clear accumulated equipment
// and have the lead restate from scratch. Regex is intentionally specific:
// requires "start fresh" or "recapture" near "equipment" to avoid false positives.
const RESET_TRIGGER = /\b(?:start\s+fresh\s+on\s+(?:your\s+)?equipment|re-?confirm\s+(?:your\s+)?equipment\s+list|recapture\s+(?:your\s+)?equipment)\b/i;

// Default CFM estimates for equipment categories when no specific model is matched.
// Based on manufacturer pre-install guides, industry standards, and forum data.
// Conservative midpoints — better to slightly undersize than miss entirely (0 CFM).
const CATEGORY_DEFAULTS = {
  // CNC metalworking
  cnc:          { cfm_typical: 8,   psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  mill:         { cfm_typical: 8,   psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  vmc:          { cfm_typical: 8,   psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  hmc:          { cfm_typical: 10,  psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  lathe:        { cfm_typical: 5,   psi_required: 90,  duty_cycle_pct: 70, air_quality_class: 'general' },
  turning:      { cfm_typical: 5,   psi_required: 90,  duty_cycle_pct: 70, air_quality_class: 'general' },
  // CNC woodworking / routing
  router:       { cfm_typical: 15,  psi_required: 90,  duty_cycle_pct: 80, air_quality_class: 'general' },
  // Surface treatment
  paint:        { cfm_typical: 20,  psi_required: 50,  duty_cycle_pct: 60, air_quality_class: 'paint_grade' },
  booth:        { cfm_typical: 20,  psi_required: 50,  duty_cycle_pct: 60, air_quality_class: 'paint_grade' },
  spray:        { cfm_typical: 15,  psi_required: 50,  duty_cycle_pct: 60, air_quality_class: 'paint_grade' },
  blast:        { cfm_typical: 100, psi_required: 100, duty_cycle_pct: 50, air_quality_class: 'general' },
  sandblast:    { cfm_typical: 100, psi_required: 100, duty_cycle_pct: 50, air_quality_class: 'general' },
  // Packaging
  packaging:    { cfm_typical: 10,  psi_required: 80,  duty_cycle_pct: 60, air_quality_class: 'general' },
  erector:      { cfm_typical: 8,   psi_required: 80,  duty_cycle_pct: 60, air_quality_class: 'general' },
  // General pneumatic
  press:        { cfm_typical: 10,  psi_required: 90,  duty_cycle_pct: 50, air_quality_class: 'general' },
  grinder:      { cfm_typical: 6,   psi_required: 90,  duty_cycle_pct: 60, air_quality_class: 'general' },
  welder:       { cfm_typical: 5,   psi_required: 80,  duty_cycle_pct: 40, air_quality_class: 'general' },
};

// Pre-compiled word-boundary regexes for CATEGORY_DEFAULTS keywords.
// Built once at module load to avoid constructing new RegExp objects on every
// transcript chunk. Uses \b word boundaries so short keywords like "press"
// don't false-match inside words like "compressor" or "impressive".
const CATEGORY_REGEXES = Object.fromEntries(
  Object.keys(CATEGORY_DEFAULTS).map(kw => [kw, new RegExp(`\\b${kw}\\b`, 'i')])
);

// Known CNC manufacturers — when we see "Haas" with no model, apply CNC defaults
const CNC_MANUFACTURERS = new Set([
  'haas', 'mazak', 'okuma', 'dmg', 'mori', 'doosan', 'fanuc', 'hurco',
  'kitamura', 'makino', 'matsuura', 'brother', 'hyundai', 'hardinge',
  'nakamura', 'samsung', 'spinner', 'takisawa', 'tsugami', 'miyano',
  'citizen', 'star', 'tornos', 'daewoo', 'bridgeport',
]);

// Air quality context keywords — detected from transcript text, independent of
// equipment type. CNC machines default to 'general' air quality, but a shop running
// AS9100 aerospace work needs ISO_8573_1 regardless of what machines they have.
// Checked on every transcript chunk so context detected before or after equipment
// mentions still gets applied.
const AQ_CONTEXT_PATTERNS = [
  { re: /\bAS[\s-]?9100\b/i,              aqClass: 'ISO_8573_1' },
  { re: /\baerospace\b/i,                  aqClass: 'ISO_8573_1' },
  { re: /\bpharma(?:ceutical)?\b/i,       aqClass: 'ISO_8573_1' },
  { re: /\bISO[\s-]?8573\b/i,             aqClass: 'ISO_8573_1' },
  { re: /\bmedical[\s-]?devices?\b/i,      aqClass: 'ISO_8573_1' },
  { re: /\bclean[\s-]?room\b/i,           aqClass: 'ISO_8573_1' },
  { re: /\bpaint[\s-]?booth\b/i,          aqClass: 'paint_grade' },
  { re: /\bspray[\s-]?booth\b/i,          aqClass: 'paint_grade' },
  { re: /\bauto[\s-]?body\b/i,            aqClass: 'paint_grade' },
  { re: /\bpowder[\s-]?coat(?:ing)?\b/i,  aqClass: 'paint_grade' },
];

/**
 * Scan transcript text for air quality context signals.
 * Returns the highest-priority air quality class found, or null.
 */
function detectAirQualityContext(text) {
  let best = null;
  let bestRank = 0;
  for (const { re, aqClass } of AQ_CONTEXT_PATTERNS) {
    if (re.test(text) && (AQ_RANK[aqClass] || 0) > bestRank) {
      best = aqClass;
      bestRank = AQ_RANK[aqClass] || 0;
    }
  }
  return best;
}

/**
 * Match entity text against CATEGORY_DEFAULTS keywords using pre-compiled regexes.
 * Returns the matched category name or null.
 */
function matchCategory(text) {
  for (const [keyword, re] of Object.entries(CATEGORY_REGEXES)) {
    if (re.test(text)) return keyword;
  }
  return null;
}

/**
 * Get default specs for an equipment entity that didn't match the catalog.
 * Uses manufacturer name, model keywords, and raw mention to infer category.
 * Returns { ...specs, confidence, _category } or null.
 */
function getCategoryDefault(entity) {
  const text = [entity.manufacturer, entity.model, entity.raw_mention]
    .filter(Boolean).join(' ').toLowerCase();

  // Check known CNC manufacturers first
  if (entity.manufacturer && CNC_MANUFACTURERS.has(entity.manufacturer.toLowerCase())) {
    return { ...CATEGORY_DEFAULTS.cnc, confidence: 'category_default', _category: 'cnc' };
  }

  // Match keywords with word boundaries to avoid false positives
  // (e.g., "press" must not match "compressor" or "impressive")
  const cat = matchCategory(text);
  if (cat) return { ...CATEGORY_DEFAULTS[cat], confidence: 'category_default', _category: cat };

  return null;
}

/**
 * Infer the equipment category for a specific (non-generic) entity.
 * Used to match specific mentions back to generic ones for supersession.
 * Shares matchCategory() with getCategoryDefault to avoid duplicate regexes.
 */
function inferCategory(entity) {
  if (entity.manufacturer && CNC_MANUFACTURERS.has(entity.manufacturer.toLowerCase())) {
    return 'cnc';
  }
  const text = [entity.manufacturer, entity.model, entity.raw_mention]
    .filter(Boolean).join(' ').toLowerCase();
  return matchCategory(text);
}

/**
 * Supersede generic accumulated entries when a specific entity refines them.
 *
 * Example: "5 CNC machines" (generic, count 5) followed by "three Haas VF-2s"
 * (specific, count 3) → generic count reduced to 2. The Haas machines ARE some
 * of the 5 CNCs, not additional equipment.
 *
 * Only supersedes entries that:
 *   (A) match the same equipment category (e.g., both are 'cnc')
 *   (B) were added within SUPERSEDE_WINDOW chunks (proximity guard)
 *
 * Mutates accumulated in place. Returns the number of units consumed from generics.
 */
function supersedeGenerics(accumulated, category, specificCount, chunkNum) {
  if (!category || specificCount <= 0) return 0;

  let remaining = specificCount;
  let consumed = 0;

  for (let i = accumulated.length - 1; i >= 0 && remaining > 0; i--) {
    const entry = accumulated[i];
    if (!entry._meta.isGeneric || entry._meta.category !== category) continue;
    if (chunkNum - (entry._meta.chunkNum || 0) > SUPERSEDE_WINDOW) continue;

    const take = Math.min(entry.count, remaining);
    entry.count -= take;
    remaining -= take;
    consumed += take;

    if (entry.count <= 0) {
      accumulated.splice(i, 1);
    }
  }

  if (consumed > 0) {
    console.log(`[SIZING-DIAG] superseded ${consumed} generic '${category}' units (${specificCount} specific arrived, ${remaining} unmatched)`);
  }

  return consumed;
}

/**
 * Resolve the highest-priority air quality class from both equipment specs
 * and conversation context (AS9100, aerospace, etc.). Context signals override
 * equipment defaults because CNC machines are always 'general' even in
 * aerospace shops.
 */
function resolveAirQuality(accumulated, callId) {
  let bestAq = null;
  let bestPriority = 0;

  // Check equipment-derived air quality
  for (const item of accumulated) {
    const p = AQ_RANK[item.air_quality_class] || 0;
    if (p > bestPriority) {
      bestPriority = p;
      bestAq = item.air_quality_class;
    }
  }

  // Check conversation context (may override equipment defaults)
  const contextAq = getCallAirQuality(callId);
  const contextP = AQ_RANK[contextAq] || 0;
  if (contextP > bestPriority) bestAq = contextAq;

  return bestAq;
}

/**
 * Process a transcript chunk through the equipment detection pipeline.
 *
 * @param {string} callId   - WebSocket broadcast channel (e.g. 'conf_abc' or 'sim-42')
 * @param {string} callType - 'real' or 'practice' (for equipment_sightings)
 * @param {string} dbCallId - Database row ID (string) for sighting logging
 * @param {string} text     - Transcript text to process
 */
async function processEquipmentChunk(callId, callType, dbCallId, text) {
  const counter = chunkCounters.get(callId);
  const chunkNum = (counter ? counter.count : 0) + 1;
  chunkCounters.set(callId, { count: chunkNum, ts: Date.now() });

  // Verbal reset: rep says trigger phrase → clear equipment, start fresh.
  // Detected before extraction so the same chunk can contain both the reset
  // phrase and new equipment mentions (e.g. "let me re-confirm your equipment
  // list — so you said three Haas VF-2s?").
  if (RESET_TRIGGER.test(text)) {
    console.log(`[SIZING-DIAG] ${callId} EQUIPMENT RESET triggered at chunk ${chunkNum}`);
    resetCallEquipment(callId);
    chunkCounters.set(callId, { count: 0, ts: Date.now() });
    broadcast(callId, { type: 'equipment_reset', data: { chunkNum } });
  }

  const detectedAq = detectAirQualityContext(text);
  let aqEscalated = false;
  if (detectedAq) aqEscalated = setCallAirQuality(callId, detectedAq);

  const entities = await extractEquipment(text);

  // If no new equipment but air quality escalated and we have prior equipment,
  // re-trigger the recommendation with the upgraded air quality.
  const accumulated = getCallEquipment(callId);
  if (entities.length === 0) {
    if (aqEscalated && accumulated.length > 0) {
      const demand = calculateDemand(accumulated);
      const recommendation = recommendSystem(demand);
      if (recommendation) {
        const bestAq = resolveAirQuality(accumulated, callId);
        addQualityFilters(recommendation, bestAq);
        deriveSalesChannel(recommendation);
        broadcast(callId, { type: 'recommendation_ready', data: recommendation });
      }
    }
    return;
  }

  let sizingChanged = false;

  for (const entity of entities) {
    try {
      let result = null;
      if (entity.manufacturer && entity.model) {
        result = await lookupEquipment(entity.manufacturer, entity.model);
      }

      // If no catalog match, apply category defaults based on equipment type.
      // "4 CNC machines" with no model → 8 CFM each instead of 0 CFM.
      const categoryFallback = !result ? getCategoryDefault(entity) : null;

      const specs = result ? {
        cfm_typical: result.cfm_typical,
        psi_required: result.psi_required,
        duty_cycle_pct: result.duty_cycle_pct,
        air_quality_class: result.air_quality_class,
        confidence: result.confidence,
      } : categoryFallback ? {
        cfm_typical: categoryFallback.cfm_typical,
        psi_required: categoryFallback.psi_required,
        duty_cycle_pct: categoryFallback.duty_cycle_pct,
        air_quality_class: categoryFallback.air_quality_class,
        confidence: categoryFallback.confidence,
      } : null;

      // Learn variant: if lookup matched but extracted model differs from canonical,
      // persist the alias so future lookups hit Step 2 (variant match) instead of Step 3 (fuzzy).
      if (result) {
        const canonical = result.model.toLowerCase();
        const newVariants = new Set();
        if (entity.model && entity.model.toLowerCase() !== canonical) newVariants.add(entity.model);
        if (entity.raw_mention && entity.raw_mention.toLowerCase() !== canonical) newVariants.add(entity.raw_mention);
        for (const v of newVariants) addVariant(result.id, v).catch(() => {}); // fire-and-forget; addVariant logs internally
      }

      await logSighting({
        manufacturer: entity.manufacturer,
        model: entity.model,
        raw_mention: entity.raw_mention,
        count: entity.count,
        call_type: callType,
        call_id: dbCallId,
        catalog_match_id: result?.id ?? null,
      });

      broadcast(callId, {
        type: 'equipment_detected',
        data: {
          manufacturer: entity.manufacturer,
          model: entity.model,
          count: entity.count,
          specs,
          catalogMatch: !!result,
        },
      });

      const cfm = parseFloat(specs?.cfm_typical) || 0;
      if (cfm > 0 && accumulated.length < 100) {
        const isGeneric = !entity.manufacturer && !entity.model;
        const category = categoryFallback?._category || inferCategory(entity);

        // Sizing data (read by calculateDemand, resolveAirQuality) lives at top level.
        // Pipeline-internal tracking lives in _meta so it never leaks to consumers.
        const entry = {
          cfm_typical: cfm,
          duty_cycle_pct: parseInt(specs.duty_cycle_pct, 10) || 50,
          psi_required: parseInt(specs.psi_required, 10) || 90,
          air_quality_class: specs.air_quality_class || 'general',
          count: entity.count,
          _meta: {
            manufacturer: entity.manufacturer || null,
            model: entity.model || null,
            confidence: specs.confidence || 'catalog',
            isGeneric,
            category,
            chunkNum,
            rawMention: entity.raw_mention || '',
          },
        };

        if (!isGeneric && category) {
          supersedeGenerics(accumulated, category, entity.count, chunkNum);
        }

        accumulated.push(entry);
        sizingChanged = true;

        if (process.env.SIZING_DEBUG) {
          console.debug(`[SIZING-DIAG] ${callId} accumulated[${accumulated.length - 1}]:`, JSON.stringify({
            mfg: entity.manufacturer, model: entity.model, count: entity.count,
            cfm, isGeneric, category, chunkNum, confidence: specs.confidence,
            raw: entity.raw_mention,
          }));
        }
      }
    } catch (err) {
      console.error(`equipment-pipeline: failed for ${entity.manufacturer} ${entity.model}:`, err.message);
    }
  }

  if (sizingChanged) {
    const demand = calculateDemand(accumulated);

    if (process.env.SIZING_DEBUG) {
      console.debug(`[SIZING-DIAG] ${callId} pre-sizing state:`, JSON.stringify({
        itemCount: accumulated.length,
        equipmentCount: demand?.equipmentCount,
        totalCfmAtDuty: demand?.totalCfmAtDuty,
        adjustedCfm: demand?.adjustedCfm,
        items: accumulated.map((a, i) => ({
          i, mfg: a._meta.manufacturer, model: a._meta.model, count: a.count,
          cfm: a.cfm_typical, generic: a._meta.isGeneric,
        })),
      }));
    }

    broadcast(callId, { type: 'sizing_updated', data: demand });

    const recommendation = recommendSystem(demand);
    if (recommendation) {
      const bestAq = resolveAirQuality(accumulated, callId);
      addQualityFilters(recommendation, bestAq);
      deriveSalesChannel(recommendation);
      broadcast(callId, { type: 'recommendation_ready', data: recommendation });
    }
  }
}

/**
 * Clean up pipeline state for a completed call.
 * Also sweeps stale entries from calls that terminated abnormally
 * (never hit the /status callback) to bound the chunkCounters leak surface.
 */
function cleanupPipelineState(callId) {
  chunkCounters.delete(callId);

  const now = Date.now();
  for (const [id, { ts }] of chunkCounters) {
    if (now - ts > STALE_CALL_MS) chunkCounters.delete(id);
  }
}

module.exports = {
  processEquipmentChunk, detectAirQualityContext, resolveAirQuality,
  AQ_CONTEXT_PATTERNS, supersedeGenerics, inferCategory, cleanupPipelineState,
  SUPERSEDE_WINDOW, RESET_TRIGGER,
};
