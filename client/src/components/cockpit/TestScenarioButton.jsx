/**
 * TestScenarioButton — Dropdown that feeds transcript scenarios through the
 * equipment pipeline and broadcasts results to the LiveAnalysis WebSocket.
 *
 * Only rendered on the Joruva Test Co cockpit (gated by parent).
 */

import { useState, useRef, useEffect } from 'react';
import { runTestScenario } from '../../lib/api';

const SCENARIOS = [
  {
    id: 'machine-shop-cnc',
    label: 'Machine Shop — 4 CNC',
    chunks: [
      "Yeah so we've got four CNC machines on the floor right now.",
      "Two of them are Haas, a VF-2 and a VF-4. Both running pretty much all day.",
      "Then we've got a Mazak QTN-200 lathe, that one's probably our busiest machine.",
      "And an old Bridgeport manual mill that we still use for one-offs.",
      "We also have a Clemco 2452 blast cabinet in the back for finishing work.",
      "Everything runs off one compressor right now and I think we're starving the CNCs on pressure.",
    ],
  },
  {
    id: 'compressor-replacement',
    label: 'Compressor Replacement — Atlas Copco',
    chunks: [
      "We've got two compressors right now, an Atlas Copco GA30 that's about twelve years old.",
      "And a Kaeser ASD 40 that we bought used maybe five years ago.",
      "The Atlas Copco is giving us problems, high oil carryover, and the maintenance costs are killing us.",
      "The Kaeser still runs fine but it's oversized for what we need on second shift.",
      "I'd like to look at replacing both with one good rotary screw unit.",
      "I think something like the JRS-30 with a JRD-100 dryer would be a good fit for your demand.",
      "What kind of pressure are you running? We need about 110 PSI at the header.",
    ],
  },
  {
    id: 'paint-booth-aerospace',
    label: 'Paint Booth + Aerospace',
    chunks: [
      "We do aerospace coatings, mostly primer and topcoat on aluminum parts.",
      "Main booth has two painters running Devilbiss GTi Pro guns, those pull about 12 CFM each.",
      "Second booth is SATA, couple SATA Jet 5000s, similar air draw.",
      "We also run a small Clemco 1028 blast cabinet for surface prep before prime.",
      "And a Nordson Encore powder coating unit on the other line.",
      "Air quality is critical for us, any moisture or oil and we're scrapping parts. We're AS9100 certified.",
      "Current compressor is a 25 horse Ingersoll Rand UP6, it's been solid but we're adding the powder line.",
    ],
  },
  {
    id: 'packaging-high-volume',
    label: 'Packaging Line — High Volume',
    chunks: [
      "We run three packaging lines, pretty much 16 hours a day.",
      "Each line has a Wexxar case erector, the WF-2 model, those use a surprising amount of air.",
      "Then Loveshaw LD-16 case sealers on the end of each line.",
      "Line one has a Pearson CE25-T palletizer that's pneumatic, that's our biggest air hog.",
      "We've also got Nordson ProBlue hot melt units but those are electric, shouldn't affect air right?",
      "The whole plant runs off a 30 horse Sullair that's been here since we moved in.",
      "We're adding a fourth line next quarter so we need to size for that too.",
    ],
  },
  {
    id: 'woodworking',
    label: 'Woodworking Shop',
    chunks: [
      "We're a custom cabinet shop, do a lot of high-end residential work.",
      "Our main machine is a Thermwood Model 45 CNC router, five by ten table.",
      "We also have a ShopBot PRSalpha for simpler nested parts.",
      "The guys use Dynabrade 69505 random orbit sanders all day, probably four of those going at once.",
      "And we've got a small spray room with Iwata LPH-400 guns for lacquer and conversion varnish.",
      "Running a piston compressor right now, I think it's a 7.5 horse Campbell Hausfeld.",
      "It cycles constantly and we get moisture in the spray guns, ruins the finish.",
    ],
  },
  {
    id: 'mixed-large',
    label: 'Mixed Manufacturing — Large',
    chunks: [
      "We're about 80,000 square feet, four main departments.",
      "CNC department has a Haas UMC-750 five-axis, that's our newest machine.",
      "Two DMG Mori NLX 2500 lathes that run lights-out on weekends.",
      "And an Okuma GENOS M560 vertical mill, that one's been reliable.",
      "Molding department has two Fanuc Roboshot injection machines, those are all electric but the mold clamps use air.",
      "In the tool room we've got a Grizzly G0766 surface grinder and a manual lathe.",
      "Welding shop runs Miller Dynasty 400 TIG welders, the purge gas is separate but they use air for the plasma cutter.",
      "Oh and I forgot, the loading dock has a stretch wrapper and two air hoists for material handling.",
      "We're probably pushing 200 CFM on a busy day. Current setup is two old recip compressors daisy-chained together.",
    ],
  },
];

export default function TestScenarioButton({ onCallIdReady }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handleSelect(scenario) {
    setOpen(false);
    setRunning(scenario.id);
    try {
      const { callId } = await runTestScenario(scenario.chunks, 1200);
      onCallIdReady(callId);
    } catch (err) {
      console.error('Test scenario failed:', err);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={!!running}
        className="text-[11px] font-semibold tracking-[1px] px-3 py-1.5 rounded transition-colors"
        style={{
          background: running ? 'var(--cockpit-live-500)' : 'var(--cockpit-live-bg)',
          color: running ? '#fff' : 'var(--cockpit-live-500)',
          border: '1px solid var(--cockpit-live-border)',
        }}
      >
        {running ? 'Running...' : 'Test Scenario'}
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 z-50 rounded-lg shadow-lg overflow-hidden"
          style={{
            background: 'var(--cockpit-card)',
            border: '1px solid var(--cockpit-card-border)',
            minWidth: '280px',
          }}
        >
          <div
            className="px-3 py-2 text-[10px] font-semibold tracking-[1.5px] uppercase"
            style={{ color: 'var(--cockpit-text-muted)', borderBottom: '1px solid var(--cockpit-card-border)' }}
          >
            Feed transcript scenario
          </div>
          {SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => handleSelect(s)}
              className="w-full text-left px-3 py-2.5 text-sm transition-colors hover:brightness-125"
              style={{
                color: 'var(--cockpit-text)',
                borderBottom: '1px solid var(--cockpit-card-border)',
                background: 'transparent',
              }}
            >
              {s.label}
              <span className="block text-[11px] mt-0.5" style={{ color: 'var(--cockpit-text-muted)' }}>
                {s.chunks.length} chunks
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
