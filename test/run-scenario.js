#!/usr/bin/env node

/**
 * run-scenario.js — Feed transcript scenarios through the equipment pipeline
 * and report detections, sizing, and recommendations.
 *
 * Usage:
 *   node test/run-scenario.js                          # run all scenarios
 *   node test/run-scenario.js machine-shop-cnc          # run one scenario
 *   node test/run-scenario.js --live machine-shop-cnc   # broadcast to WebSocket UI
 *
 * Requires DATABASE_URL and ANTHROPIC_API_KEY in env (or .env file).
 */

const fs = require('fs');
const path = require('path');

// Load env from project root .env if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const { processEquipmentChunk } = require('../server/lib/equipment-pipeline');
const { broadcast, getCallEquipment, cleanupCall } = require('../server/lib/live-analysis');
const { CAS_MODEL_PREFIX, CAS_MANUFACTURERS } = require('../server/lib/entity-extractor');

const SCENARIO_DIR = path.join(__dirname, 'scenarios');
const CHUNK_DELAY_MS = 800; // simulate realistic transcription pacing

// Intercept broadcasts to capture results
const captured = [];
const origBroadcast = broadcast;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runScenario(scenarioFile, { live = false } = {}) {
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const callId = `test-${Date.now()}`;
  const dbCallId = '0'; // dummy

  captured.length = 0;

  // Monkey-patch broadcast to capture messages (and optionally forward to real WS)
  const liveAnalysis = require('../server/lib/live-analysis');
  const realBroadcast = liveAnalysis.broadcast;
  liveAnalysis.broadcast = function(cid, message) {
    captured.push(message);
    if (live) realBroadcast(cid, message);
  };

  console.log('\n' + '═'.repeat(70));
  console.log(`  ${scenario.name}`);
  console.log('─'.repeat(70));
  console.log(`  ${scenario.description}`);
  console.log('═'.repeat(70));

  const startTime = Date.now();

  for (let i = 0; i < scenario.chunks.length; i++) {
    const chunk = scenario.chunks[i];
    const chunkNum = `[${i + 1}/${scenario.chunks.length}]`;
    process.stdout.write(`\n  ${chunkNum} "${chunk.substring(0, 60)}${chunk.length > 60 ? '...' : ''}"\n`);

    await processEquipmentChunk(callId, 'test', dbCallId, chunk);

    // Show what was detected from this chunk
    const newDetections = captured.filter(m => m.type === 'equipment_detected');
    const chunkDetections = newDetections.slice(-10); // last batch from this chunk
    if (chunkDetections.length > 0 && i === scenario.chunks.length - 1 || chunkDetections.some(d => !captured._lastShown?.has(JSON.stringify(d)))) {
      // We'll show all at the end
    }

    if (live) await sleep(CHUNK_DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Restore broadcast
  liveAnalysis.broadcast = realBroadcast;

  // Report
  const equipment = captured.filter(m => m.type === 'equipment_detected').map(m => m.data);
  const sizingMsgs = captured.filter(m => m.type === 'sizing_updated');
  const recoMsgs = captured.filter(m => m.type === 'recommendation_ready');

  const finalSizing = sizingMsgs.length > 0 ? sizingMsgs[sizingMsgs.length - 1].data : null;
  const finalReco = recoMsgs.length > 0 ? recoMsgs[recoMsgs.length - 1].data : null;

  console.log('\n' + '─'.repeat(70));
  console.log('  DETECTIONS');
  console.log('─'.repeat(70));

  if (equipment.length === 0) {
    console.log('  (none)');
  } else {
    for (const eq of equipment) {
      const match = eq.catalogMatch ? '✓ catalog' : '? unmatched';
      const cfm = eq.specs?.cfm_typical ? `${eq.specs.cfm_typical} CFM` : 'no specs';
      console.log(`  ${eq.manufacturer || '?'} ${eq.model || '?'} ×${eq.count}  [${match}] [${cfm}]`);
    }
  }

  // Check against expected
  if (scenario.expectedEquipment) {
    console.log('\n  Expected vs Actual:');
    const detected = equipment.map(e => `${e.manufacturer || ''} ${e.model || ''}`.trim().toLowerCase());
    for (const exp of scenario.expectedEquipment) {
      const found = detected.some(d => d.includes(exp.toLowerCase()) || exp.toLowerCase().includes(d));
      console.log(`    ${found ? '✓' : '✗'} ${exp}`);
    }
  }

  if (scenario.expectedFiltered) {
    console.log('\n  Correctly Filtered (should NOT appear):');
    const detected = equipment.map(e => `${e.manufacturer || ''} ${e.model || ''}`.trim().toLowerCase());
    for (const exp of scenario.expectedFiltered) {
      const found = detected.some(d => d.includes(exp.toLowerCase()));
      console.log(`    ${found ? '✗ LEAKED' : '✓ filtered'} ${exp}`);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log('  SIZING');
  console.log('─'.repeat(70));

  if (!finalSizing) {
    console.log('  (no sizing data — no equipment with known CFM specs)');
  } else {
    console.log(`  Demand:    ${finalSizing.totalCfmAtDuty} CFM`);
    console.log(`  Peak:      ${finalSizing.peakCfm} CFM`);
    console.log(`  Pressure:  ${finalSizing.maxPsi} PSI`);
    console.log(`  Machines:  ${finalSizing.equipmentCount}`);

    if (scenario.expectedDemandRange) {
      const { minCfm, maxCfm } = scenario.expectedDemandRange;
      const actual = finalSizing.totalCfmAtDuty;
      const inRange = actual >= minCfm && actual <= maxCfm;
      console.log(`  Expected:  ${minCfm}–${maxCfm} CFM  ${inRange ? '✓' : `✗ OUT OF RANGE`}`);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log('  RECOMMENDATION');
  console.log('─'.repeat(70));

  if (!finalReco) {
    console.log('  (none)');
  } else {
    const c = finalReco.compressor;
    if (c) {
      const parallel = finalReco.parallelConfig
        ? `${finalReco.parallelConfig.unitCount}× `
        : '';
      console.log(`  Compressor:  ${parallel}${c.model} (${c.hp} HP, ${c.cfm} CFM)`);
      console.log(`  Price:       ${c.price ? '$' + c.price.toLocaleString() : 'quote required'}`);
      console.log(`  Channel:     ${finalReco.salesChannel || 'n/a'}`);
    }
    if (finalReco.dryer) {
      console.log(`  Dryer:       ${finalReco.dryer.model}${finalReco.dryerType === 'desiccant' ? ' (desiccant)' : ''}`);
    }
    if (finalReco.filters?.length) {
      console.log(`  Filters:     ${finalReco.filters.map(f => typeof f === 'string' ? f : f.model).join(', ')}`);
    }
    if (finalReco.ows) {
      console.log(`  OWS:         ${finalReco.ows.model}`);
    }
    if (finalReco.pmVsdAlternative) {
      console.log(`  VSD Alt:     ${finalReco.pmVsdAlternative.model} (${finalReco.pmVsdAlternative.hp} HP, energy upgrade)`);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`  Completed in ${elapsed}s — ${equipment.length} detections, ${sizingMsgs.length} sizing updates, ${recoMsgs.length} recommendations`);
  console.log('═'.repeat(70));

  cleanupCall(callId);

  return {
    name: scenario.name,
    equipment,
    sizing: finalSizing,
    recommendation: finalReco,
    elapsed,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const scenarioNames = args.filter(a => a !== '--live');

  let files;
  if (scenarioNames.length > 0) {
    files = scenarioNames.map(name => {
      const f = path.join(SCENARIO_DIR, name.endsWith('.json') ? name : `${name}.json`);
      if (!fs.existsSync(f)) {
        console.error(`Scenario not found: ${f}`);
        process.exit(1);
      }
      return f;
    });
  } else {
    files = fs.readdirSync(SCENARIO_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => path.join(SCENARIO_DIR, f));
  }

  if (files.length === 0) {
    console.error('No scenarios found in', SCENARIO_DIR);
    process.exit(1);
  }

  console.log(`\nRunning ${files.length} scenario(s)${live ? ' [LIVE — broadcasting to WebSocket]' : ''}...\n`);

  const results = [];
  for (const f of files) {
    results.push(await runScenario(f, { live }));
  }

  // Summary table
  if (results.length > 1) {
    console.log('\n\n' + '═'.repeat(70));
    console.log('  SUMMARY');
    console.log('═'.repeat(70));
    for (const r of results) {
      const cfm = r.sizing ? `${r.sizing.totalCfmAtDuty} CFM` : 'no sizing';
      const reco = r.recommendation?.compressor?.model || 'none';
      console.log(`  ${r.name}`);
      console.log(`    ${r.equipment.length} detections | ${cfm} | → ${reco} | ${r.elapsed}s`);
    }
    console.log('═'.repeat(70));
  }

  // Exit after all DB queries settle
  setTimeout(() => process.exit(0), 500);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
