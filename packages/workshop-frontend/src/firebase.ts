import { initializeApp, FirebaseApp, FirebaseOptions } from 'firebase/app';
import { getMessaging, getToken, deleteToken, Messaging, onMessage } from 'firebase/messaging';
import { FcmConfig } from '@gadgets/workshop-shared/api';

export { getToken, deleteToken, onMessage };
export type { FcmConfig };

export function initFirebase(config: FcmConfig): FirebaseApp {
  const options: FirebaseOptions = {
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket,
    messagingSenderId: config.messagingSenderId,
    appId: config.appId,
  };
  return initializeApp(options);
}

export function getFirebaseMessaging(app: FirebaseApp): Messaging {
  return getMessaging(app);
}
