// ─── Cache config ────────────────────────────────────────────────────────────
const CACHE_VERSION = 'cgo-v13';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/offline.html',
  '/logo-icon.png',
  '/logo-192.png',
  '/logo-512.png',
  '/manifest.json'
];

// ─── Install : pre-cache static shell (resilient — n'échoue pas si un asset manque)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

// ─── Activate : purge stale caches + prendre contrôle immédiat des pages ouvertes
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch strategy ──────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET ou cross-origin → bypass total
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // /api/* → network uniquement, jamais de cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Navigation → network-first, fallback offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(request, clone)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/offline.html').then(r => r || Response.error()))
    );
    return;
  }

  // Assets statiques → cache-first avec mise à jour silencieuse en arrière-plan
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => cached);

      return cached || networkFetch;
    })
  );
});

// ─── Push notifications ───────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const d = event.data.json();
  event.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      tag: d.tag || 'demande',
      data: { url: d.url || '/' },
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const target = new URL(url, self.location.origin);
      for (const c of list) {
        const cu = new URL(c.url);
        if (cu.pathname === target.pathname) {
          c.focus();
          const tab = target.searchParams.get('tab');
          if (tab) c.postMessage({ type: 'navigate-tab', tab });
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
