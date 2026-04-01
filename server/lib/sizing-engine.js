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
  { model: 'JRS-5E',    hp: 5,    cfm: 18,  psi: 150, price: null,  voltage: '230V/1ph' },
  { model: 'JRS-7.5E',  hp: 7.5,  cfm: 28,  psi: 150, price: 7495,  voltage: '230V/1ph or 3ph' },
  { model: 'JRS-10E',   hp: 10,   cfm: 40,  psi: 150, price: 9495,  voltage: '460V/3ph' },
  { model: 'JRS-15E',   hp: 15,   cfm: 60,  psi: 150, price: null,  voltage: '460V/3ph' },
  { model: 'JRS-20E',   hp: 20,   cfm: 80,  psi: 150, price: null,  voltage: '460V/3ph' },
  { model: 'JRS-25E',   hp: 25,   cfm: 100, psi: 150, price: null,  voltage: '460V/3ph' },
];

// CAS refrigerated air dryers — all 115V, stocked. ~45% gross margin.
const DRYER_CATALOG = [
  { model: 'JRD-30',   cfm: 30,  voltage: '115V/1/60', cost: 1197,  price: 2195, cas_sku: 'RD30' },
  { model: 'JRD-40',   cfm: 40,  voltage: '115V/1/60', cost: 1340,  price: 2495, cas_sku: 'RD40' },
  { model: 'JRD-60',   cfm: 60,  voltage: '115V/1/60', cost: 1569,  price: 2895, cas_sku: 'RD60' },
  { model: 'JRD-80',   cfm: 80,  voltage: '115V/1/60', cost: 1718,  price: 3195, cas_sku: 'RD80' },
  { model: 'JRD-100',  cfm: 100, voltage: '115V/1/60', cost: 1976,  price: 3595, cas_sku: 'RD100' },
];

// CAS wall-mount desiccant dryers — stocked, -60°F dewpoint.
// Molecular sieve media (not activated alumina) — premium product class.
// 6061 billet aluminum housing, spin-on canister, 1/3 size of conventional units.
const DESICCANT_CATALOG = [
  { model: 'JDD-40',  cfm: 40, voltage: '115V', dewpoint: -60, cost: 4705, price: 7495, cas_sku: 'SODD10HPN4NY' },
  { model: 'JDD-80',  cfm: 80, voltage: '115V', dewpoint: -60, cost: 6525, price: 11895, cas_sku: 'SODD20HPN4NY' },
];

// CAS inline filters — stocked. ~49% gross margin.
// "-70" = up to 70 CFM (compressors up to 10HP), "-130" = up to 130 CFM (15HP+).
const FILTER_SIZES = {
  particulate: [
    { model: 'JPF-70',  cfm: 70,  micron: 1,    cost: 229.00, price: 399, cas_sku: 'PF-70' },
    { model: 'JPF-130', cfm: 130, micron: 1,    cost: 229.00, price: 499, cas_sku: 'PF-130' },
  ],
  coalescing: [
    { model: 'JCF-70',  cfm: 70,  micron: 0.01, cost: 176.50, price: 349, cas_sku: 'CF-70' },
    { model: 'JCF-130', cfm: 130, micron: 0.01, cost: 229.00, price: 449, cas_sku: 'CF-130' },
  ],
};

// Backward compat — legacy tests reference FILTER_CATALOG
const FILTER_CATALOG = {
  particulate: FILTER_SIZES.particulate[1],
  coalescing:  FILTER_SIZES.coalescing[1],
};

function selectFilter(type, cfm) {
  const sizes = FILTER_SIZES[type];
  return sizes.find(f => f.cfm >= cfm) || sizes[sizes.length - 1];
}

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

  // Always include particulate pre-filter sized to match compressor output.
  // Coalescing filter added separately via addQualityFilters() when air
  // quality class requires it.
  const filters = [selectFilter('particulate', compressor.cfm)];

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
    const hasCoalescing = recommendation.filters.some(f => f.micron <= 0.01);
    if (!hasCoalescing) {
      const cfm = recommendation.compressor?.cfm || 55;
      recommendation.filters.push({ ...selectFilter('coalescing', cfm) });
      recommendation.notes.push('Coalescing filter added for air quality requirements');
    }

    // Suggest desiccant dryer upgrade for aerospace/ISO environments
    const desiccant = DESICCANT_CATALOG.find(d => d.cfm >= (recommendation.compressor?.cfm || 40))
      || DESICCANT_CATALOG[DESICCANT_CATALOG.length - 1];
    recommendation.desiccantUpgrade = { ...desiccant };
    recommendation.notes.push(
      `Consider desiccant dryer upgrade (${desiccant.model}, $${desiccant.price?.toLocaleString()}) — molecular sieve media achieves ${desiccant.dewpoint}°F dewpoint vs 38°F refrigerated. Required for AS9100/pharma.`
    );
  }
}

module.exports = {
  calculateDemand,
  recommendSystem,
  addQualityFilters,
  selectFilter,
  SAFETY_FACTOR,
  COMPRESSOR_CATALOG,
  DRYER_CATALOG,
  DESICCANT_CATALOG,
  FILTER_CATALOG,
  FILTER_SIZES,
};
