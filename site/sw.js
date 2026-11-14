// Minimal service worker so the dashboard installs as an app. Always goes to the network; nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
