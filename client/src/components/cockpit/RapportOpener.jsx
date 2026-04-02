export default function RapportOpener({ openingLine }) {
  if (!openingLine) return null;

  return (
    <div
      className="rounded-r py-3 px-3.5 mb-3 transition-colors duration-300"
      style={{
        background: 'var(--cockpit-amber-50)',
        borderLeft: '4px solid var(--cockpit-amber-600)',
      }}
    >
      <div className="flex items-start gap-2.5">
        <span className="text-lg shrink-0 mt-0.5">🎯</span>
        <div>
          <div
            className="text-[11px] font-semibold uppercase tracking-[1.5px] mb-0.5"
            style={{ color: 'var(--cockpit-amber-600)' }}
          >
            Suggested opener
          </div>
          <div
            className="text-sm font-normal leading-[1.4]"
            style={{ color: 'var(--cockpit-amber-900)' }}
          >
            {openingLine}
          </div>
        </div>
      </div>
    </div>
  );
}
