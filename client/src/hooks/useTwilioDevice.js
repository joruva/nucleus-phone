import { useState, useEffect, useRef, useCallback } from 'react';
import { Device } from '@twilio/voice-sdk';
import { getToken } from '../lib/api';

export default function useTwilioDevice(identity) {
  const [device, setDevice] = useState(null);
  const [call, setCall] = useState(null);
  const [status, setStatus] = useState('initializing');
  const deviceRef = useRef(null);

  useEffect(() => {
    if (!identity) return;

    let destroyed = false;

    async function init() {
      try {
        const { token } = await getToken(identity);

        if (destroyed) return;

        const dev = new Device(token, {
          edge: 'ashburn',
          logLevel: 'warn',
        });

        dev.on('registered', () => {
          if (!destroyed) setStatus('ready');
        });

        dev.on('error', (err) => {
          console.error('Twilio Device error:', err);
          if (!destroyed) setStatus('error');
        });

        dev.on('tokenWillExpire', async () => {
          try {
            const { token: newToken } = await getToken(identity);
            dev.updateToken(newToken);
          } catch (err) {
            console.error('Token refresh failed:', err);
          }
        });

        await dev.register();
        deviceRef.current = dev;
        if (!destroyed) setDevice(dev);
      } catch (err) {
        console.error('Device init failed:', err);
        if (!destroyed) setStatus('error');
      }
    }

    init();

    return () => {
      destroyed = true;
      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }
    };
  }, [identity]);

  const makeCall = useCallback(async (params) => {
    if (!deviceRef.current) throw new Error('Device not ready');

    setStatus('connecting');

    const activeCall = await deviceRef.current.connect({ params });

    activeCall.on('ringing', (hasEarlyMedia) => {
      setStatus(hasEarlyMedia ? 'ringing' : 'connecting');
    });

    activeCall.on('accept', () => setStatus('connected'));

    activeCall.on('disconnect', () => {
      setStatus('disconnected');
      setCall(null);
    });

    activeCall.on('cancel', () => {
      setStatus('ready');
      setCall(null);
    });

    activeCall.on('error', (err) => {
      console.error('Call error:', err);
      setStatus('error');
      setCall(null);
    });

    setCall(activeCall);
    return activeCall;
  }, []);

  const hangUp = useCallback(() => {
    if (call) call.disconnect();
  }, [call]);

  const toggleMute = useCallback(() => {
    if (call) {
      call.mute(!call.isMuted());
      return !call.isMuted();
    }
    return false;
  }, [call]);

  const sendDigits = useCallback((digits) => {
    if (call) call.sendDigits(digits);
  }, [call]);

  return { device, call, status, setStatus, makeCall, hangUp, toggleMute, sendDigits };
}
