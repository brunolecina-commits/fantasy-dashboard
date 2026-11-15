// Service worker: makes the dashboard installable, and checks the server for a newer page, script or
// data file every time instead of trusting the browser cache (GitHub Pages lets browsers keep files 10 minutes).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => fetch(e.request)));
});
