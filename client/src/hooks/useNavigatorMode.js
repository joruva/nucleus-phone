import { useCallback, useEffect, useState } from 'react';

/**
 * Navigator mode toggle (per-call override only).
 *
 * The toggle controls whether the Conversation Navigator UI renders for the
 * current call. Default = on. Toggling via the cockpit header flips it for
 * the current call only; changing `callId` resets to the default.
 *
 * There is no sticky localStorage preference today — when a settings surface
 * exists, add it here. Don't add the storage plumbing speculatively.
 */
export default function useNavigatorMode(callId) {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setEnabled(true);
  }, [callId]);

  const toggleNavigator = useCallback(() => {
    setEnabled((prev) => !prev);
  }, []);

  return {
    navigatorEnabled: enabled,
    toggleNavigator,
  };
}
