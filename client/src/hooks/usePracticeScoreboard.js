import { useState, useEffect, useRef, useCallback } from 'react';
import { getPracticeScoreboard } from '../lib/api';

export default function usePracticeScoreboard(enabled = true) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const controllerRef = useRef(null);

  const fetchData = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);
    getPracticeScoreboard(controller.signal)
      .then(setData)
      .catch(err => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => {
      clearInterval(interval);
      controllerRef.current?.abort();
    };
  }, [fetchData, enabled]);

  return { data, loading, error, refresh: fetchData };
}
