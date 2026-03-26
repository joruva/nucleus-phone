import { useState, useCallback } from 'react';
import { searchContacts } from '../lib/api';

export default function useContacts() {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchContacts = useCallback(async (query = '') => {
    setLoading(true);
    setError(null);
    try {
      const data = await searchContacts(query, 50);
      setContacts(data.contacts || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { contacts, loading, error, fetchContacts };
}
