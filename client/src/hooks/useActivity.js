import { useState, useEffect, useRef, useCallback } from 'react';
import { getActivity } from '../lib/api';

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 300;

/**
 * Unified hook for the Activity tab — replaces useCallSummaries.
 * Handles FTS search, caller filter, date range, disposition/qualification,
 * pagination, and StrictMode double-fetch guard.
 */
export default function useActivity(identity, role) {
  const [activity, setActivity] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [caller, setCaller] = useState(role === 'admin' ? '' : identity);
  const [filter, setFilter] = useState('all'); // all | hot | warm | connected | voicemail | today | thisWeek | hasNotes
  // State (not ref) so hasMore triggers re-renders cleanly and Load More hides
  // on the same render that setActivity fires.
  const [loaded, setLoaded] = useState(0);

  const abortRef = useRef(null);
  const debounceRef = useRef(null);
  const mountedRef = useRef(false);

  // Translate filter pill into server query params.
  const filterParams = useCallback(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - 6);

    switch (filter) {
      case 'hot':
        return { qualification: 'hot' };
      case 'warm':
        return { qualification: 'warm' };
      case 'connected':
        return { disposition: 'connected' };
      case 'voicemail':
        return { disposition: 'voicemail' };
      case 'today':
        return { from: startOfToday.toISOString() };
      case 'thisWeek':
        return { from: startOfWeek.toISOString() };
      case 'hasNotes':
        return { hasSummary: true };
      case 'all':
      default:
        return {};
    }
  }, [filter]);

  const fetchActivity = useCallback(async (opts = {}) => {
    const { append = false } = opts;
    if (!append) setLoading(true);

    // Capture current loaded count for the fetch; state update happens after.
    const currentOffset = append ? loaded : 0;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await getActivity({
        caller: caller || undefined,
        q: search || undefined,
        ...filterParams(),
        limit: PAGE_SIZE,
        offset: currentOffset,
        signal: controller.signal,
      });

      const newCalls = data.calls || [];
      if (append) {
        setActivity((prev) => [...prev, ...newCalls]);
        setLoaded(currentOffset + newCalls.length);
      } else {
        setActivity(newCalls);
        setLoaded(newCalls.length);
      }
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError('Failed to load activity');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [search, caller, filterParams, loaded]);

  // Initial fetch + refetch on caller/filter change.
  // Clears any pending debounced search so we don't race it.
  useEffect(() => {
    clearTimeout(debounceRef.current);
    fetchActivity();
    mountedRef.current = true;
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caller, filter]);

  // Debounced search — skip initial mount (handled by above effect)
  useEffect(() => {
    if (!mountedRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchActivity();
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const loadMore = useCallback(() => {
    if (loaded < total) {
      fetchActivity({ append: true });
    }
  }, [total, loaded, fetchActivity]);

  // Merge a single updated row after disposition save (no full refetch)
  const mergeRow = useCallback((updatedRow) => {
    setActivity((prev) =>
      prev.map((row) => (row.id === updatedRow.id ? { ...row, ...updatedRow } : row))
    );
  }, []);

  const hasMore = loaded < total;

  return {
    activity,
    total,
    loading,
    error,
    search,
    setSearch,
    caller,
    setCaller: role === 'admin' ? setCaller : undefined,
    filter,
    setFilter,
    loadMore,
    hasMore,
    mergeRow,
    refresh: () => fetchActivity(),
  };
}
