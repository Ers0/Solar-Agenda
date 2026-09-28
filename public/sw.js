// ============================================================================
// Service Worker for Solar Agenda — Push Notifications & SLA Background Reminders
// ============================================================================

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle incoming Web Push (if push service is configured)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const payload = event.data.json();
    const title = payload.title || 'Solar Agenda — Alerta SLA';
    const options = {
      body: payload.body || 'Atualização importante em caso de suporte solar.',
      icon: payload.icon || '/favicon.ico',
      badge: payload.badge || '/favicon.ico',
      tag: payload.tag || 'solar-sla-alert',
      data: payload.data || {},
      renotify: payload.renotify !== false,
      requireInteraction: payload.requireInteraction || false
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    const text = event.data.text();
    event.waitUntil(self.registration.showNotification('Solar Agenda', { body: text }));
  }
});

// Handle notification click: focus or open Solar Agenda tab and navigate to case
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const caseId = data.caseId || data.slaid || null;
  const targetUrl = caseId ? `/?view=sla&case=${encodeURIComponent(caseId)}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (caseId) {
            client.postMessage({
              type: 'SOLAR_OPEN_SLA_CASE',
              caseId: caseId
            });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
