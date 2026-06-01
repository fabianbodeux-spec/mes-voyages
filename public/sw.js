// ─── Cache config ────────────────────────────────────────────────────────────
const CACHE_VERSION = 'cgo-v60';
// NE PAS inclure app.js et style.css non versionnés ici :
// le serveur les sert via /app?vXX et /style.css?vXX → deux entrées distinctes
// dans le cache coexisteraient et créeraient un conflit (stale + fresh en même temps)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/logo-icon.png',
  '/logo-192.png',
  '/logo-512.png',
  '/manifest.json',
  // Polices auto-hébergées — changent rarement, mise en cache agressive
  '/fonts/Satoshi-400.woff2',
  '/fonts/Satoshi-500.woff2',
  '/fonts/Satoshi-700.woff2',
  '/fonts/Satoshi-900.woff2'
];

// Helper — fetch en court-circuitant le cache HTTP du navigateur
// Évite que le SW serve du contenu périmé via le cache HTTP intermédiaire
const freshFetch = (req) => fetch(new Request(req, { cache: 'no-store' }));

// ─── Install : pre-cache static shell (resilient — n'échoue pas si un asset manque)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // cache: 'no-store' garantit que le pre-cache installe le contenu le plus récent
      .then(cache => Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(new Request(url, { cache: 'no-store' })))
      ))
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

  // Centre de Commandement → totalement indépendant de l'app : le SW n'intervient jamais
  if (url.pathname === '/cockpit' || url.pathname.startsWith('/cockpit/')) return;

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

  // Navigation → network-first (bypass HTTP cache), fallback offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      freshFetch(request)
        .then(response => {
          // Ne mettre en cache que les réponses OK — jamais une page d'erreur ou offline
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request)
          .then(cached => {
            // Servir le cache seulement si c'est une vraie page (pas offline.html en fallback)
            if (cached) return cached;
            return caches.match('/offline.html').then(r => r || Response.error());
          })
        )
    );
    return;
  }

  // JS / CSS / HTML → network-first (bypass HTTP cache) : toujours la version fraîche
  if (/\.(js|css|html)(\?.*)?$/.test(url.pathname) || url.pathname === '/' || url.pathname === '/app') {
    event.respondWith(
      freshFetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Images / fonts / icônes → cache-first (changent rarement)
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

// ─── Message : activation forcée depuis le client ────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── Push notifications ───────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const d = event.data.json();
  event.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: '/logo-192.png',
      badge: '/logo-192.png',
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
