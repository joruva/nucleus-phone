/**
 * sizing-engine.js — Deterministic compressed air system sizing.
 *
 * No AI calls. Pure math: sum CFM at duty cycle, apply safety factor,
 * map to CAS product catalog.
 */

const SAFETY_FACTOR = 1.25; // Industry standard: 25% buffer for leaks + growth

// CAS compressor catalog, ordered by CFM capacity.
// price: null means "pricing available on request" (TBD with CAS).
const COMPRESSOR_CATALOG = [
  { model: 'JRS-7.5E',  hp: 7.5,  cfm: 28,  psi: 150, price: 7495,  voltage: '230V/1ph or 3ph' },
  { model: 'JRS-10E',   hp: 10,   cfm: 40,  psi: 150, price: 9495,  voltage: '460V/3ph' },
  { model: 'JRS-15E',   hp: 15,   cfm: 60,  psi: 150, price: null,  voltage: '460V/3ph' },
  { model: 'JRS-20E',   hp: 20,   cfm: 80,  psi: 150, price: null,  voltage: '460V/3ph' },
  { model: 'JRS-25E',   hp: 25,   cfm: 100, psi: 150, price: null,  voltage: '460V/3ph' },
];

const DRYER_CATALOG = [
  { model: 'RD40-115',  cfm: 40,  voltage: '115V/1/60', price: null },
  { model: 'RD75-115',  cfm: 75,  voltage: '115V/1/60', price: null },
  { model: 'RD100-230', cfm: 100, voltage: '230V/1/60', price: null },
];

const FILTER_CATALOG = {
  particulate: { model: 'PF-55-8', cfm: 55, micron: 1, price: null },
  coalescing:  { model: 'CF-55-8', cfm: 55, micron: 0.01, price: null },
};

/**
 * Calculate total air demand from a list of equipment.
 * Each item: { cfm_typical, cfm_max, duty_cycle_pct, psi_required, count }
 *
 * Returns null if equipmentList is empty or has no CFM data.
 */
function calculateDemand(equipmentList) {
  if (!equipmentList || equipmentList.length === 0) return null;

  let totalCfmAtDuty = 0;
  let peakCfm = 0;
  let maxPsi = 0;
  let equipmentCount = 0;

  for (const item of equipmentList) {
    const cfmTypical = parseFloat(item.cfm_typical) || 0;
    const cfmMax = parseFloat(item.cfm_max) || cfmTypical;
    const rawDuty = parseInt(item.duty_cycle_pct, 10);
    const dutyCycle = (Number.isNaN(rawDuty) ? 100 : rawDuty) / 100;
    const psi = parseInt(item.psi_required, 10) || 0;
    const rawCount = parseInt(item.count, 10);
    const count = rawCount > 0 ? rawCount : 1;

    totalCfmAtDuty += cfmTypical * dutyCycle * count;
    peakCfm += cfmMax * count;
    if (psi > maxPsi) maxPsi = psi;
    equipmentCount += count;
  }

  if (totalCfmAtDuty === 0 && peakCfm === 0) return null;

  // Apply safety factor
  const adjustedCfm = Math.ceil(totalCfmAtDuty * SAFETY_FACTOR);
  const adjustedPeak = Math.ceil(peakCfm * SAFETY_FACTOR);

  return {
    totalCfmAtDuty: Math.round(totalCfmAtDuty * 10) / 10,
    peakCfm: Math.round(peakCfm * 10) / 10,
    adjustedCfm,
    adjustedPeak,
    maxPsi: maxPsi || 90, // default 90 PSI if none specified
    equipmentCount,
  };
}

/**
 * Recommend a CAS compressed air system based on demand.
 * Returns null if demand is null.
 */
function recommendSystem(demand) {
  if (!demand) return null;

  // Select compressor: smallest unit that meets adjusted CFM
  const compressor = COMPRESSOR_CATALOG.find(c => c.cfm >= demand.adjustedCfm)
    || COMPRESSOR_CATALOG[COMPRESSOR_CATALOG.length - 1]; // largest if nothing fits

  // Select dryer: smallest that covers compressor CFM output
  const dryer = DRYER_CATALOG.find(d => d.cfm >= compressor.cfm)
    || DRYER_CATALOG[DRYER_CATALOG.length - 1];

  // Always include particulate pre-filter — standard practice for any
  // compressed air system. Coalescing filter added separately via
  // addQualityFilters() when air quality class requires it.
  const filters = [FILTER_CATALOG.particulate];

  const notes = [];

  // Flag if demand exceeds our largest unit
  if (demand.adjustedCfm > COMPRESSOR_CATALOG[COMPRESSOR_CATALOG.length - 1].cfm) {
    notes.push(`Demand (${demand.adjustedCfm} CFM) exceeds largest single unit — consider parallel configuration`);
  }

  // Flag high PSI requirements
  if (demand.maxPsi > 125) {
    notes.push(`High PSI requirement (${demand.maxPsi}) — verify equipment specs`);
  }

  return {
    compressor: { ...compressor },
    dryer: { ...dryer },
    filters: filters.map(f => ({ ...f })),
    demand: { ...demand },
    notes,
  };
}

/**
 * Mutates recommendation in-place: adds coalescing filter when air quality
 * class requires it (AS9100/ISO_8573_1, paint grade). No return value.
 */
function addQualityFilters(recommendation, airQualityClass) {
  if (!recommendation || !airQualityClass) return;

  const needsCoalescing = airQualityClass === 'ISO_8573_1' || airQualityClass === 'paint_grade';
  if (needsCoalescing) {
    const hasCoalescing = recommendation.filters.some(f => f.model === FILTER_CATALOG.coalescing.model);
    if (!hasCoalescing) {
      recommendation.filters.push({ ...FILTER_CATALOG.coalescing });
      recommendation.notes.push('Coalescing filter added for air quality requirements');
    }
  }
}

module.exports = {
  calculateDemand,
  recommendSystem,
  addQualityFilters,
  SAFETY_FACTOR,
  COMPRESSOR_CATALOG,
  DRYER_CATALOG,
  FILTER_CATALOG,
};
