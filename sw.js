// Service worker: shows reminders pushed by the server, even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'Activity Logger', {
      body: data.body || 'What are you doing right now?',
      tag: 'activity-logger',
      renotify: true,
      requireInteraction: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { asked: data.asked },
    });
    // Let an open copy of the app show the new question straight away.
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage('refresh');
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = new URL('./?answer=1', self.registration.scope).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of windows) {
      if ('focus' in c) { c.postMessage('refresh'); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

// Always check for the newest version of the app's own files, so updates
// show up the next time it opens instead of after the browser cache expires.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)));
});
