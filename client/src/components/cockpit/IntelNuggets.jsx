const CATEGORY_COLORS = {
  APPROACH: {
    bg: 'var(--cockpit-blue-50)',
    accent: 'var(--cockpit-blue-500)',
    text: 'var(--cockpit-blue-900)',
  },
  'WATCH OUT': {
    bg: 'var(--cockpit-orange-50)',
    accent: 'var(--cockpit-orange-500)',
    text: 'var(--cockpit-orange-900)',
  },
  OPPORTUNITY: {
    bg: 'var(--cockpit-green-50)',
    accent: 'var(--cockpit-green-500)',
    text: 'var(--cockpit-green-900)',
  },
  CONTEXT: {
    bg: 'var(--cockpit-gray-50)',
    accent: 'var(--cockpit-text-muted)',
    text: 'var(--cockpit-text)',
  },
};

function categorize(text) {
  const lower = (text || '').toLowerCase();
  if (/\b(opportunity|potential|upgrade)\b/.test(lower))
    return 'OPPORTUNITY';
  if (/\b(watch out|caution|risk|warning)\b/.test(lower))
    return 'WATCH OUT';
  return 'APPROACH';
}

export default function IntelNuggets({ nuggets, watchOuts, label }) {
  const items = [];

  if (nuggets?.length) {
    nuggets.forEach(n => {
      if (typeof n === 'object' && n.category) {
        items.push(n);
      } else {
        const text = typeof n === 'string' ? n : n.text || String(n);
        items.push({ category: categorize(text), headline: text, body: '' });
      }
    });
  }

  if (watchOuts?.length) {
    watchOuts.forEach(w => {
      const text = typeof w === 'string' ? w : w.text || String(w);
      items.push({ category: 'WATCH OUT', headline: text, body: '' });
    });
  }

  if (!items.length) return null;

  return (
    <div className="mb-3 min-w-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-[1.5px]">
          {label || 'Intelligence nuggets'}
        </div>
        {items.length > 10 && (
          <div className="text-xs text-cp-text-muted">
            Swipe →
          </div>
        )}
      </div>
      <div
        className="grid gap-2 overflow-x-auto pb-2 snap-x snap-mandatory"
        style={{
          gridTemplateRows: 'repeat(2, auto)',
          gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(160px, 180px)',
          scrollbarWidth: 'thin',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {items.map((n, i) => {
          const c = CATEGORY_COLORS[n.category] || CATEGORY_COLORS.APPROACH;
          return (
            <div
              key={i}
              className="snap-start rounded py-2.5 px-3 transition-colors duration-300"
              style={{
                background: c.bg,
                borderTop: `3px solid ${c.accent}`,
              }}
            >
              <div
                className="text-[11px] font-semibold uppercase tracking-[1.5px] mb-1"
                style={{ color: c.accent }}
              >
                {n.category}
              </div>
              <div className="text-sm font-normal leading-[1.3]" style={{ color: c.text }}>
                {n.headline}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
