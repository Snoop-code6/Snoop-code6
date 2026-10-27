// Service worker de MAKORA HIT : démarrage hors ligne de l'interface et notifications push.
// Les données (/api) ne sont jamais mises en cache : elles restent privées et toujours à jour.

const CACHE = 'makora-shell-v1';
const SHELL = [
  '/', '/app.js', '/app.css', '/markdown.js', '/favicon.svg', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/badge-72.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord (pour toujours servir la dernière version), cache en secours hors ligne.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })
    .catch(() => caches.match(event.request)
      .then((cached) => cached ?? (event.request.mode === 'navigate' ? caches.match('/') : Response.error()))));
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'MAKORA HIT', body: event.data?.text() ?? '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'MAKORA HIT', {
    body: data.body ?? '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
  }));
});

// Un clic sur la notification ramène sur la bonne conversation, dans un onglet existant si possible.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) {
      existing.postMessage({ type: 'navigate', url });
      return existing.focus();
    }
    return self.clients.openWindow(url);
  }));
});
