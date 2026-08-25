// firebase-messaging-sw.js
// This service worker is registered from a blob URL after injecting self.firebaseConfig.
importScripts('https://www.gstatic.com/firebasejs/11.15.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.15.0/firebase-messaging-compat.js');

const config = self.firebaseConfig;
if (config && config.apiKey && config.messagingSenderId) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || payload.data?.title || 'Aarya Smart';
    const body = payload.notification?.body || payload.data?.body || '';
    const link = payload.data?.link || payload.fcmOptions?.link;
    const notificationOptions = {
      body,
      icon: '/favicon.svg',
      data: { link },
    };
    self.registration.showNotification(title, notificationOptions);
  });

  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const link = event.notification.data?.link;
    event.waitUntil(
      clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((windowClients) => {
          if (link) {
            for (const client of windowClients) {
              if (client.url === link && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(link);
          }
          if (windowClients.length && 'focus' in windowClients[0]) {
            return windowClients[0].focus();
          }
          if (clients.openWindow) return clients.openWindow('/');
        }),
    );
  });
}
