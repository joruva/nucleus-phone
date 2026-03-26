import { useState, useRef, useCallback, useEffect } from 'react';
import { initiateCall, joinCall } from '../lib/api';

export default function useCallState(twilioHook) {
  const { makeCall, hangUp, status } = twilioHook;

  const [callData, setCallData] = useState(null); // { conferenceName, callId, contact }
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);

  // Timer for call duration
  useEffect(() => {
    if (status === 'connected' && !timerRef.current) {
      const start = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    }

    if (status === 'disconnected' || status === 'ready') {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status]);

  const startCall = useCallback(async (contact, identity) => {
    const phone = contact.properties?.phone || contact.properties?.mobilephone;
    if (!phone) throw new Error('Contact has no phone number');

    const { conferenceName, callId } = await initiateCall({
      to: phone,
      contactName: `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim(),
      companyName: contact.properties.company || '',
      contactId: contact.id,
      callerIdentity: identity,
    });

    setCallData({ conferenceName, callId, contact });
    setElapsed(0);

    await makeCall({
      To: phone,
      ConferenceName: conferenceName,
      CallerIdentity: identity,
      Action: 'initiate',
    });
  }, [makeCall]);

  const joinExistingCall = useCallback(async (conferenceName, identity, muted = true) => {
    await joinCall({ conferenceName, callerIdentity: identity, muted });

    setCallData((prev) => ({ ...prev, conferenceName, joined: true }));
    setElapsed(0);

    await makeCall({
      ConferenceName: conferenceName,
      CallerIdentity: identity,
      Action: 'join',
      Muted: muted ? 'true' : 'false',
    });
  }, [makeCall]);

  const endCurrentCall = useCallback(() => {
    hangUp();
    // callData preserved for disposition screen
  }, [hangUp]);

  const clearCallData = useCallback(() => {
    setCallData(null);
    setElapsed(0);
  }, []);

  return {
    callData, elapsed, startCall, joinExistingCall, endCurrentCall, clearCallData,
  };
}
