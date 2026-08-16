// Deliberately does NOT cache anything. Jarvis changes often right now, and a
// caching service worker would mean your phone/PC keep showing an old version
// after you push updates — exactly the kind of stale-file bug that's been a
// pain already. This just satisfies "installable app" requirements and always
// hits the real network.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
