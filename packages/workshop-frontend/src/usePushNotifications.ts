import { useState, useCallback, useEffect, useRef } from 'react';
import { AuthenticatedApi, FcmConfig } from '@gadgets/workshop-shared/api';
import { RpcStub } from 'capnweb';
import { initFirebase, getFirebaseMessaging, getToken, deleteToken, onMessage } from './firebase';

type PushState =
  | { status: 'idle' }
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'subscribing' }
  | { status: 'subscribed'; token: string }
  | { status: 'error'; message: string };

function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

async function registerServiceWorkerWithConfig(config: FcmConfig): Promise<ServiceWorkerRegistration> {
  const swPath = '/firebase-messaging-sw.js';
  const response = await fetch(swPath);
  let template = await response.text();

  // Prepend the Firebase config so the static SW template can initialize Firebase.
  const configScript = `self.firebaseConfig = ${JSON.stringify({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket,
    messagingSenderId: config.messagingSenderId,
    appId: config.appId,
  })};\n`;
  const blob = new Blob([configScript + template], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const registration = await navigator.serviceWorker.register(blobUrl);
    await navigator.serviceWorker.ready;
    return registration;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function usePushNotifications(authenticatedApi: RpcStub<AuthenticatedApi>, fcmConfig: FcmConfig | null) {
  const [state, setState] = useState<PushState>({ status: 'idle' });
  const stateRef = useRef<PushState>(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!isNotificationSupported()) {
      setState({ status: 'unsupported' });
      return;
    }
    if (Notification.permission === 'denied') {
      setState({ status: 'denied' });
    }
  }, []);

  useEffect(() => {
    if (!fcmConfig || !isNotificationSupported()) return;

    const messaging = getFirebaseMessaging(initFirebase(fcmConfig));
    const unsubscribe = onMessage(messaging, (payload) => {
      const title = payload.notification?.title ?? payload.data?.title ?? 'Aarya Smart';
      const body = payload.notification?.body ?? payload.data?.body ?? '';
      // eslint-disable-next-line no-new
      new Notification(title, { body, icon: '/favicon.svg' });
    });

    return () => unsubscribe();
  }, [fcmConfig]);

  const subscribe = useCallback(async () => {
    if (!fcmConfig) {
      setState({ status: 'error', message: 'Push notifications are not configured.' });
      return;
    }
    if (!isNotificationSupported()) {
      setState({ status: 'unsupported' });
      return;
    }
    setState({ status: 'subscribing' });

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? { status: 'denied' } : { status: 'error', message: 'Notification permission not granted.' });
        return;
      }

      const registration = await registerServiceWorkerWithConfig(fcmConfig);
      const messaging = getFirebaseMessaging(initFirebase(fcmConfig));
      const token = await getToken(messaging, {
        vapidKey: fcmConfig.vapidKey,
        serviceWorkerRegistration: registration,
      });

      if (!token) {
        setState({ status: 'error', message: 'Failed to get FCM registration token.' });
        return;
      }

      await authenticatedApi.registerPushSubscription(token);
      setState({ status: 'subscribed', token });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [authenticatedApi, fcmConfig]);

  const unsubscribe = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== 'subscribed' || !fcmConfig) return;
    try {
      const messaging = getFirebaseMessaging(initFirebase(fcmConfig));
      await Promise.all([
        deleteToken(messaging),
        authenticatedApi.unregisterPushSubscription(current.token),
      ]);
      setState({ status: 'idle' });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [authenticatedApi, fcmConfig]);

  return { state, subscribe, unsubscribe };
}
