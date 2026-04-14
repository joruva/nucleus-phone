/**
 * SentimentArc — trailing sentiment-over-time arc chart.
 *
 * Replaces the 4px SentimentBar with a proper Vonnegut-style sentiment arc:
 *   - y-axis: numeric sentiment score (hostile -2 → positive +1.5)
 *   - x-axis: time (most recent reading at the right)
 *   - baseline: dotted line at 0 (neutral)
 *   - fill:    soft gradient below (red) / above (green) the baseline
 *   - head:    emphasized dot at the latest reading
 *
 * The arc tells the caller at a glance: where are we, and which way is it
 * heading. Momentum modifies the numeric score as a small nudge, so a
 * "positive + declining" point sits slightly below "positive + building".
 */

import { SENTIMENT_HISTORY_MAX } from './navigator-constants';

const MIN_Y = -2;
const MAX_Y = 1.5;
const HEIGHT = 56;
const PADDING_Y = 4;

const CUSTOMER_SCORE = {
  hostile: -2,
  negative: -1,
  guarded: -0.5,
  neutral: 0,
  positive: 1,
};

const MOMENTUM_NUDGE = {
  tanking: -0.5,
  declining: -0.3,
  steady: 0,
  building: 0.3,
};

export function scoreEntry(entry) {
  if (!entry) return null;
  const base = CUSTOMER_SCORE[entry.customer];
  if (base == null) return null;
  const nudge = MOMENTUM_NUDGE[entry.momentum] ?? 0;
  const raw = base + nudge;
  // Clamp so momentum can't push past the scale ends
  return Math.max(MIN_Y, Math.min(MAX_Y, raw));
}

function scoreToY(score) {
  // MAX_Y maps to PADDING_Y; MIN_Y maps to HEIGHT - PADDING_Y
  const usable = HEIGHT - 2 * PADDING_Y;
  const ratio = (MAX_Y - score) / (MAX_Y - MIN_Y);
  return PADDING_Y + ratio * usable;
}

const BASELINE_Y = scoreToY(0);

export default function SentimentArc({ history = [], degraded = false, maxPoints = SENTIMENT_HISTORY_MAX }) {
  const points = history.slice(-maxPoints);

  // Empty state: render the baseline frame so the slot doesn't jump when
  // data starts flowing.
  if (points.length === 0) {
    return (
      <svg
        viewBox={`0 0 100 ${HEIGHT}`}
        preserveAspectRatio="none"
        className="w-full transition-opacity duration-300"
        style={{ height: HEIGHT, opacity: degraded ? 0.4 : 0.6 }}
        aria-hidden="true"
      >
        <line
          x1="0" x2="100" y1={BASELINE_Y} y2={BASELINE_Y}
          stroke="var(--cockpit-card-border)"
          strokeWidth="1" strokeDasharray="2 3"
        />
      </svg>
    );
  }

  // viewBox x runs 0..100; space points evenly. Width of each slot =
  // 100 / (maxPoints - 1) so a full history stretches edge-to-edge.
  const step = 100 / Math.max(1, maxPoints - 1);
  const startOffset = (maxPoints - points.length) * step; // right-align

  const coords = points.map((entry, i) => {
    const score = scoreEntry(entry);
    return {
      x: startOffset + i * step,
      y: score == null ? BASELINE_Y : scoreToY(score),
      score,
      entry,
    };
  });

  // Polyline path for the arc line itself
  const linePath = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(' ');

  // Closed path for the filled area — drops to baseline at the edges so the
  // fill sits between curve and zero line, not curve and bottom of chart.
  const fillPath =
    `M ${coords[0].x.toFixed(2)} ${BASELINE_Y} ` +
    coords.map((c) => `L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ') +
    ` L ${coords[coords.length - 1].x.toFixed(2)} ${BASELINE_Y} Z`;

  const head = coords[coords.length - 1];
  const headAbove = head.y < BASELINE_Y;

  return (
    <svg
      viewBox={`0 0 100 ${HEIGHT}`}
      preserveAspectRatio="none"
      className="w-full transition-opacity duration-300"
      style={{ height: HEIGHT, opacity: degraded ? 0.5 : 1 }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sentArcPos" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--cockpit-nav-positive)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--cockpit-nav-positive)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sentArcNeg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--cockpit-nav-negative)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--cockpit-nav-negative)" stopOpacity="0.35" />
        </linearGradient>
        {/* Clip the fill so "above zero" portion uses the positive gradient
            and "below zero" uses the negative gradient. Two overlapping fills
            with rect clips handles this without splitting the path. */}
        <clipPath id="sentArcAbove">
          <rect x="0" y="0" width="100" height={BASELINE_Y} />
        </clipPath>
        <clipPath id="sentArcBelow">
          <rect x="0" y={BASELINE_Y} width="100" height={HEIGHT - BASELINE_Y} />
        </clipPath>
      </defs>

      {/* Fill under curve — split above/below zero via clip paths */}
      <path d={fillPath} fill="url(#sentArcPos)" clipPath="url(#sentArcAbove)" />
      <path d={fillPath} fill="url(#sentArcNeg)" clipPath="url(#sentArcBelow)" />

      {/* Zero baseline */}
      <line
        x1="0" x2="100" y1={BASELINE_Y} y2={BASELINE_Y}
        stroke="var(--cockpit-card-border)"
        strokeWidth="1" strokeDasharray="2 3"
        vectorEffect="non-scaling-stroke"
      />

      {/* The arc itself */}
      <path
        d={linePath}
        fill="none"
        stroke={headAbove ? 'var(--cockpit-nav-positive)' : 'var(--cockpit-nav-negative)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* Head marker — latest reading */}
      <circle
        cx={head.x}
        cy={head.y}
        r="2.5"
        fill={headAbove ? 'var(--cockpit-nav-positive)' : 'var(--cockpit-nav-negative)'}
        stroke="var(--cockpit-card)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
