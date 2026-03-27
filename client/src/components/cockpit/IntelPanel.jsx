import { useState } from 'react';

export default function IntelPanel({ rapport }) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const nuggets = rapport?.intel_nuggets || [];
  const script = rapport?.adapted_script || '';

  if (!nuggets.length && !script) return null;

  return (
    <div className="bg-jv-card border border-jv-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-jv-muted uppercase tracking-wider mb-3">Intel</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Nuggets */}
        {nuggets.length > 0 && (
          <div className="space-y-2">
            {nuggets.map((nugget, i) => (
              <div
                key={i}
                className="flex items-start gap-2 p-2 rounded-lg bg-jv-amber/10 border border-jv-amber/20"
              >
                <span className="text-jv-amber mt-0.5 shrink-0">&#9679;</span>
                <p className="text-sm">{nugget}</p>
              </div>
            ))}
          </div>
        )}

        {/* Adapted script */}
        {script && (
          <div>
            <button
              onClick={() => setScriptOpen(!scriptOpen)}
              className="flex items-center gap-2 text-sm text-jv-blue hover:text-jv-blue/80 mb-2"
            >
              <span className={`transition-transform ${scriptOpen ? 'rotate-90' : ''}`}>&#9654;</span>
              Adapted Script
            </button>
            {scriptOpen && (
              <p className="text-sm text-gray-300 leading-relaxed pl-5">{script}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
