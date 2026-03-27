import { useState, useEffect, useCallback } from 'react';
import { getCallHistory } from '../lib/api';
import { formatDuration } from '../lib/format';

const DISP_COLORS = {
  connected: 'bg-jv-green/20 text-jv-green',
  voicemail: 'bg-jv-blue/20 text-jv-blue',
  no_answer: 'bg-gray-500/20 text-gray-400',
  callback_requested: 'bg-jv-amber/20 text-jv-amber',
  qualified_hot: 'bg-jv-red/20 text-jv-red',
  qualified_warm: 'bg-jv-amber/20 text-jv-amber',
  not_interested: 'bg-jv-red/20 text-jv-red',
  wrong_number: 'bg-jv-red/20 text-jv-red',
  gatekeeper: 'bg-gray-500/20 text-gray-400',
};

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 1) return 'Yesterday ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function History({ identity, role }) {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useState(role === 'admin' ? '' : identity);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getCallHistory({ caller: filter || undefined, limit: 50 });
      setCalls(data.calls || []);
    } catch (err) {
      setError('Failed to load call history');
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  return (
    <div className="h-full overflow-y-auto scroll-container p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Call History</h2>
        {role === 'admin' && (
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-jv-card border border-jv-border rounded-lg px-3 py-1.5 text-sm text-white"
          >
            <option value="">All callers</option>
            <option value="ryann">Ryann</option>
            <option value="tom">Tom</option>
            <option value="alex">Alex</option>
          </select>
        )}
      </div>

      {loading && <p className="text-center text-jv-muted py-8">Loading...</p>}

      {error && <p className="text-center text-jv-red py-8">{error}</p>}

      {!loading && !error && calls.length === 0 && (
        <p className="text-center text-jv-muted py-8">No calls yet</p>
      )}

      <div className="space-y-2">
        {calls.map((call) => {
          const isExpanded = expanded === call.id;

          return (
            <div
              key={call.id}
              className="bg-jv-card border border-jv-border rounded-xl overflow-hidden"
            >
              <div
                className="flex items-center justify-between p-4 cursor-pointer"
                onClick={() => setExpanded(isExpanded ? null : call.id)}
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{call.lead_name || 'Unknown'}</p>
                  <p className="text-sm text-jv-muted truncate">{call.lead_company || ''}</p>
                  <p className="text-xs text-jv-muted mt-1">{formatDate(call.created_at)}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm text-jv-muted">{formatDuration(call.duration_seconds)}</span>
                  {call.disposition && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${DISP_COLORS[call.disposition] || 'bg-gray-500/20 text-gray-400'}`}>
                      {call.disposition.replace(/_/g, ' ')}
                    </span>
                  )}
                  <span className="text-xs text-jv-muted capitalize">{call.caller_identity}</span>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 pb-4 border-t border-jv-border pt-3 space-y-2">
                  {call.notes && <p className="text-sm">{call.notes}</p>}
                  {call.qualification && (
                    <p className="text-sm"><span className="text-jv-muted">Qualification:</span> {call.qualification}</p>
                  )}
                  {call.products_discussed?.length > 0 && (
                    <p className="text-sm"><span className="text-jv-muted">Products:</span> {call.products_discussed.join(', ')}</p>
                  )}
                  {call.recording_url && (
                    <a
                      href={call.recording_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-jv-blue hover:underline block"
                    >
                      Listen to recording
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
