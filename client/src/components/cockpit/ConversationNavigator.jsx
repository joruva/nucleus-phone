import { useRef, useEffect } from 'react';
import SentimentArc from './SentimentArc';
import SuggestionCard from './SuggestionCard';

const PHASE_LABEL = {
  greeting: 'Greeting',
  discovery: 'Discovery',
  qualification: 'Qualification',
  equipment_discussion: 'Equipment',
  objection_handling: 'Objection Handling',
  pricing: 'Pricing',
  closing: 'Closing',
  small_talk: 'Small Talk',
};

export default function ConversationNavigator({
  phase,
  sentiment,
  suggestionHistory = [],
  navigatorStatus = 'ok',
}) {
  const degraded = navigatorStatus === 'degraded';
  const phaseLabel = phase?.phase ? (PHASE_LABEL[phase.phase] || phase.phase) : '—';
  const keyTopic = phase?.key_topic;
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [suggestionHistory.length]);

  return (
    <div
      className="flex flex-col gap-2 px-3 py-2 transition-opacity duration-300"
      style={{
        opacity: degraded ? 0.55 : 1,
        borderTop: '1px solid var(--cockpit-card-border)',
        background: 'var(--cockpit-card)',
      }}
    >
      <SentimentArc history={sentiment?.history || []} degraded={degraded} />

      <div className="flex items-baseline gap-2 min-w-0">
        <span
          className="text-[11px] font-semibold tracking-[1.5px] uppercase shrink-0"
          style={{ color: 'var(--cockpit-text-secondary)' }}
        >
          {phaseLabel}
        </span>
        {keyTopic && (
          <span
            className="text-[11px] truncate"
            style={{ color: 'var(--cockpit-text-muted)' }}
            title={keyTopic}
          >
            — {keyTopic}
          </span>
        )}
        {degraded && (
          <span
            className="ml-auto text-[10px] font-medium tracking-[1px] uppercase"
            style={{ color: 'var(--cockpit-text-muted)' }}
          >
            Navigator limited
          </span>
        )}
      </div>

      {suggestionHistory.length > 0 && (
        <div
          ref={scrollRef}
          className="flex flex-col gap-1.5 overflow-y-auto"
          style={{ maxHeight: '240px' }}
        >
          {suggestionHistory.map((s, i) => {
            const isLatest = i === suggestionHistory.length - 1;
            return (
              <div
                key={s._receivedAt}
                style={{ opacity: isLatest ? 1 : 0.55 }}
              >
                <SuggestionCard suggestion={s} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
