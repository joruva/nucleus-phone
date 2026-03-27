const CHANNEL_ICONS = {
  voice: '\u{1F4DE}',
  email: '\u{1F4E7}',
  chatbot: '\u{1F916}',
  sms: '\u{1F4AC}',
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function TimelinePanel({ interactionHistory, priorCalls }) {
  const interactions = interactionHistory?.interactions || [];
  const calls = priorCalls || [];

  if (!interactions.length && !calls.length) {
    return (
      <div className="bg-jv-card border border-jv-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-jv-muted uppercase tracking-wider mb-2">Timeline</h3>
        <p className="text-sm text-jv-muted">No prior interactions</p>
      </div>
    );
  }

  // Merge and sort by date
  const entries = [
    ...interactions.map(i => ({
      type: 'interaction',
      channel: i.channel,
      summary: i.summary || i.disposition || i.intent || 'Interaction',
      date: i.createdAt,
    })),
    ...calls.map(c => ({
      type: 'call',
      channel: 'voice',
      summary: `${c.caller_identity} — ${c.disposition || 'no disposition'}${c.qualification ? ` (${c.qualification})` : ''}`,
      date: c.created_at,
      duration: c.duration_seconds,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);

  return (
    <div className="bg-jv-card border border-jv-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-jv-muted uppercase tracking-wider mb-3">Timeline</h3>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {entries.map((entry, i) => (
          <div key={i} className="flex items-start gap-3 text-sm">
            <span className="shrink-0 w-6 text-center" title={entry.channel}>
              {CHANNEL_ICONS[entry.channel] || '\u{1F4CB}'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="truncate">{entry.summary}</p>
              {entry.duration != null && (
                <p className="text-xs text-jv-muted">{Math.round(entry.duration / 60)}m {entry.duration % 60}s</p>
              )}
            </div>
            <span className="text-xs text-jv-muted shrink-0">{formatDate(entry.date)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
