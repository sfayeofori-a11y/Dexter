// Offline support was never an MVP requirement, and a cache-first service worker
// is a real liability for a showcase build: it'll keep serving whatever version
// of every HTML/CSS/JS file was cached under CACHE_NAME until that name changes or
// the worker is unregistered — including across our own edit sessions, and on any
// laptop that had this page open before today. Rather than trust everyone to
// remember to unregister it by hand, this file now actively cleans itself up:
// any browser that already has the old cache-first version installed will, on its
// next activate, wipe every cache it owns and unregister itself, then reload any
// open tab so it goes back to plain network fetches. index.html/project.html no
// longer register a new service worker at all (see their <script> tags), so this
// is purely a one-time self-teardown for anyone who picked up the old version.
self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (cacheNames) {
        return Promise.all(cacheNames.map(function (name) { return caches.delete(name); }));
      })
      .then(function () {
        return self.registration.unregister();
      })
      .then(function () {
        return self.clients.matchAll({ type: 'window' });
      })
      .then(function (clients) {
        clients.forEach(function (client) { client.navigate(client.url); });
      })
  );
});
