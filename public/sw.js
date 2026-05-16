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
