import { useState, useEffect } from 'react';
import { getPracticeScores } from '../../lib/api';
import { GRADE_EMOJI } from '../../lib/constants';
const DIFF_STYLE = {
  easy: { bg: 'var(--cockpit-green-50)', color: 'var(--cockpit-green-900)' },
  medium: { bg: 'var(--cockpit-amber-50)', color: 'var(--cockpit-amber-900)' },
  hard: { bg: 'var(--cockpit-red-bg)', color: 'var(--cockpit-red-text)' },
};

const CATEGORIES = [
  { key: 'rapport', label: 'Rapport', weight: '20%' },
  { key: 'discovery', label: 'Discovery', weight: '25%' },
  { key: 'objection', label: 'Objection Handling', weight: '25%' },
  { key: 'product', label: 'Product Knowledge', weight: '15%' },
  { key: 'close', label: 'Close', weight: '15%' },
];

function ScoreBar({ score }) {
  const n = Number(score) || 0;
  const pct = Math.min(100, Math.max(0, n * 10));
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--cockpit-gray-100)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: 'var(--cockpit-purple-500)' }}
        />
      </div>
      <span className="text-[11px] tabular-nums w-7 text-right" style={{ color: 'var(--cockpit-text-muted)' }}>
        {n.toFixed(1)}
      </span>
    </div>
  );
}

function HistoryRow({ score }) {
  const [expanded, setExpanded] = useState(false);
  const ds = DIFF_STYLE[score.difficulty] || DIFF_STYLE.easy;
  const emoji = GRADE_EMOJI[score.call_grade] || '🎯';
  const date = new Date(score.created_at);
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <div
      className="rounded overflow-hidden transition-colors"
      style={{ background: 'var(--cockpit-card)', border: '1px solid var(--cockpit-card-border)' }}
    >
      {/* Summary row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left cursor-pointer"
      >
        <span className="text-sm">{emoji}</span>
        <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--cockpit-text)' }}>
          {score.score_overall ? Number(score.score_overall).toFixed(1) : '—'}
        </span>
        <span
          className="text-[11px] font-medium px-1.5 py-[1px] rounded"
          style={{ background: ds.bg, color: ds.color }}
        >
          {score.difficulty}
        </span>
        <span className="flex-1" />
        <span className="text-[11px]" style={{ color: 'var(--cockpit-text-muted)' }}>
          {dateStr} {timeStr}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--cockpit-text-muted)' }}>
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2" style={{ borderTop: '1px solid var(--cockpit-card-border)' }}>
          {/* Category scores */}
          <div className="flex flex-col gap-1.5 pt-2">
            {CATEGORIES.map(cat => {
              const s = score[`score_${cat.key}`];
              const note = score[`note_${cat.key}`];
              return (
                <div key={cat.key}>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] w-[100px] shrink-0" style={{ color: 'var(--cockpit-text-secondary)' }}>
                      {cat.label}
                    </span>
                    <ScoreBar score={s} />
                  </div>
                  {note && (
                    <p className="text-[11px] ml-[100px] pl-2 mt-0.5" style={{ color: 'var(--cockpit-text-muted)' }}>
                      {note}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Debrief */}
          {score.caller_debrief && (
            <div
              className="px-3 py-2 rounded text-xs leading-relaxed mt-1"
              style={{ background: 'var(--cockpit-purple-bg)', color: 'var(--cockpit-text)' }}
            >
              {score.caller_debrief}
            </div>
          )}

          {/* Strength / improvement */}
          {score.top_strength && (
            <div className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--cockpit-green-900)' }}>
              <span>💪</span> {score.top_strength}
            </div>
          )}
          {score.top_improvement && (
            <div className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--cockpit-amber-900)' }}>
              <span>🎯</span> {score.top_improvement}
            </div>
          )}

          {/* Audio playback */}
          {score.recording_url && (
            <audio controls preload="none" className="w-full h-8 mt-1" src={score.recording_url} />
          )}
        </div>
      )}
    </div>
  );
}

export default function PracticeHistory({ identity, refreshKey }) {
  const [scores, setScores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    if (!identity) return;
    setLoading(true);
    setFetchError(null);
    getPracticeScores(identity)
      .then(data => setScores(data.scores || []))
      .catch(err => {
        setScores([]);
        setFetchError(err.message);
      })
      .finally(() => setLoading(false));
  }, [identity, refreshKey]);

  if (loading) {
    return (
      <div className="px-5 py-3">
        <div className="h-6 w-32 rounded animate-pulse" style={{ background: 'var(--cockpit-card)' }} />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="px-5 py-4 text-center">
        <p className="text-sm" style={{ color: 'var(--cockpit-red-text)' }}>
          Failed to load practice history
        </p>
      </div>
    );
  }

  if (!scores.length) {
    return (
      <div className="px-5 py-4 text-center">
        <p className="text-sm" style={{ color: 'var(--cockpit-text-muted)' }}>
          No practice calls yet. Click Practice Call to start.
        </p>
      </div>
    );
  }

  // Show last 5
  const recent = scores.slice(0, 5);

  return (
    <div className="px-5 py-3 flex flex-col gap-2">
      <h3 className="text-sm font-semibold" style={{ color: 'var(--cockpit-text-secondary)' }}>
        Recent practice calls
      </h3>
      {recent.map(s => <HistoryRow key={s.id} score={s} />)}
    </div>
  );
}
