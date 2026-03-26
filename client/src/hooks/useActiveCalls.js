import { useState, useEffect, useRef } from 'react';
import { getActiveCalls } from '../lib/api';

export default function useActiveCalls(enabled = false) {
  const [calls, setCalls] = useState([]);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;

    async function poll() {
      try {
        const data = await getActiveCalls();
        setCalls(data.calls || []);
      } catch (_) { /* ignore polling errors */ }
    }

    poll();
    intervalRef.current = setInterval(poll, 3000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled]);

  return calls;
}
