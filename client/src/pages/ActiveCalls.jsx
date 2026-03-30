import { useNavigate } from 'react-router-dom';
import useActiveCalls from '../hooks/useActiveCalls';
import { formatDuration } from '../lib/format';

export default function ActiveCalls({ identity, callState, twilioHook }) {
  const calls = useActiveCalls(true);
  const navigate = useNavigate();

  async function handleJoin(call, muted) {
    try {
      await callState.joinExistingCall(call.conferenceName, identity, muted);
      navigate('/dialer');
    } catch (err) {
      alert('Join failed: ' + err.message);
    }
  }

  return (
    <div className="h-full overflow-y-auto scroll-container p-4">
      <h2 className="text-lg font-semibold mb-4">Live Calls</h2>

      {calls.length === 0 && (
        <div className="text-center py-12">
          <p className="text-jv-muted text-lg mb-2">No active calls</p>
          <p className="text-sm text-jv-muted">Live and practice calls will appear here</p>
        </div>
      )}

      <div className="space-y-3">
        {calls.map((call) => (
          <div
            key={call.conferenceName}
            className="bg-jv-card border border-jv-border rounded-xl p-4"
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-medium">{call.leadName || 'Unknown'}</p>
                  {call.type === 'sim' && (
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded bg-purple-500/20 text-purple-400">
                      Practice
                    </span>
                  )}
                </div>
                <p className="text-sm text-jv-muted">{call.leadCompany || ''}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-jv-green">{formatDuration(call.duration)}</p>
                <p className="text-xs text-jv-muted capitalize">{call.startedBy}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 mb-3">
              <div className={`w-2 h-2 rounded-full animate-pulse ${call.type === 'sim' ? 'bg-purple-400' : 'bg-jv-green'}`} />
              <span className="text-xs text-jv-muted">
                {call.type === 'sim'
                  ? (call.simStatus === 'scoring' ? 'Scoring…' : 'In progress')
                  : `${call.participants.length} participant${call.participants.length !== 1 ? 's' : ''}`}
              </span>
            </div>

            {call.type !== 'sim' && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleJoin(call, true)}
                  disabled={twilioHook.status !== 'ready'}
                  className="flex-1 py-2.5 rounded-lg bg-jv-elevated border border-jv-border text-sm font-medium hover:bg-jv-card transition-colors disabled:opacity-40"
                >
                  Join Silent
                </button>
                <button
                  onClick={() => handleJoin(call, false)}
                  disabled={twilioHook.status !== 'ready'}
                  className="flex-1 py-2.5 rounded-lg bg-jv-blue text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
                >
                  Join Call
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
