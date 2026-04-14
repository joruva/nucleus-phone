import LiveAnalysis from './LiveAnalysis';
import ConversationNavigator from './ConversationNavigator';

/**
 * ReactorContainer — wraps LiveAnalysis (equipment) with the optional
 * Conversation Navigator underlay.
 *
 * Layering rule (per plan): Navigator sits BELOW LiveAnalysis in the DOM.
 * LiveAnalysis dominates when equipment is detected; when equipment is
 * absent (~80% of call time), the Navigator fills the visual space because
 * LiveAnalysis collapses to its idle listening state.
 *
 * The `data` prop is the full return of `useLiveAnalysis` — we spread
 * equipment fields into LiveAnalysis and route navigator fields into
 * ConversationNavigator.
 */
export default function ReactorContainer({ data, active, contact, callId, isPractice = false, navigatorEnabled = true }) {
  const safe = data || {};

  return (
    <div className="flex flex-col gap-0 min-h-0">
      <LiveAnalysis
        data={safe}
        active={active}
        contact={contact}
        callId={callId}
        isPractice={isPractice}
      />
      {navigatorEnabled && (
        <ConversationNavigator
          phase={safe.phase}
          sentiment={safe.sentiment}
          suggestion={safe.suggestion}
          navigatorStatus={safe.navigatorStatus}
          onDismissSuggestion={safe.dismissSuggestion}
        />
      )}
    </div>
  );
}
