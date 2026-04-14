import { useState, useEffect, useRef, useCallback } from 'react';

const POLL_INTERVAL = 10000;

async function fetchJson(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export default function useDebug(enabled = true) {
  const [events, setEvents] = useState(null);
  const [health, setHealth] = useState(null);
  const [connections, setConnections] = useState(null);
  const [sweep, setSweep] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);
  const abortRef = useRef(null);

  const poll = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const [evts, hlth, conns, swp] = await Promise.all([
        fetchJson('/api/debug/events?limit=100', ac.signal),
        fetchJson('/api/debug/health', ac.signal),
        fetchJson('/api/debug/connections', ac.signal),
        fetchJson('/api/debug/sweep', ac.signal),
      ]);
      if (ac.signal.aborted) return;
      setEvents(evts);
      setHealth(hlth);
      setConnections(conns);
      setSweep(swp);
      setError(null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    function start() {
      poll();
      intervalRef.current = setInterval(poll, POLL_INTERVAL);
    }

    function stop() {
      clearInterval(intervalRef.current);
      abortRef.current?.abort();
    }

    // Pause polling when tab is hidden to avoid background request spam
    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, poll]);

  return { events, health, connections, sweep, loading, error, refresh: poll };
}
