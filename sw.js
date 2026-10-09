/* Service worker — stesso schema delle altre app della suite (Bilancio, RecompApp, Style, Noi Due).
   - VERSION è la versione dell'app: è la stessa usata in index.html come ?v=VERSION.
   - Pagina: rete con timeout di 3 secondi, poi la copia salvata (funziona anche offline).
   - File con ?v= e icone: prima la cache; un nuovo rilascio cambia ?v= e quindi l'indirizzo.
   - Il nuovo worker resta in attesa finché l'app non chiede di attivarlo (avviso "Aggiorna"). */
const VERSION = '2.4.0';
const PREFIX = 'bet-tracker-';
const CACHE = PREFIX + VERSION;
const SHELL = [
  './',
  './index.html',
  './suite.js?v=2.4.0',
  './colors.css?v=2.4.0',
  './base.css?v=2.4.0',
  './shared.css?v=2.4.0',
  './app.css?v=2.4.0',
  './suite.css?v=2.4.0',
  './suite-tokens.css?v=2.4.0',
  './shared.js?v=2.4.0',
  './app.js?v=2.4.0',
  './manifest.webmanifest?v=2.4.0',
  './favicon.ico?v=2.4.0',
  './favicon-32.png?v=2.4.0',
  './apple-touch-icon.png?v=2.4.0',
  './bet-icon-192.png?v=2.4.0',
  './bet-icon-512.png?v=2.4.0'
];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (d === 'skip-waiting' || (d && d.type === 'SKIP_WAITING')) self.skipWaiting();
});

function fromNetworkAndStore(request, cacheKey) {
  return fetch(request, { cache: 'no-store' }).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(cacheKey || request, copy));
    }
    return response;
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // TheSportsDB e Supabase: sempre dalla rete

  if (req.mode === 'navigate') {
    const network = fromNetworkAndStore(req, './index.html');
    event.waitUntil(network.catch(() => {}));
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    event.respondWith(
      Promise.race([network, timeout])
        .then((res) => res || caches.match('./index.html'))
        .catch(() => caches.match('./index.html'))
        .then((res) => res || network)
    );
    return;
  }

  event.respondWith(caches.match(req).then((cached) => cached || fromNetworkAndStore(req)));
});

/* 2.3.1 — Promemoria serale (notifica push inviata dalla funzione notify-bet su Supabase) */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(
    self.registration.showNotification(d.title || 'Bet Tracker', {
      body: d.body || '',
      tag: d.tag || 'bet-tracker',
      icon: './bet-icon-192.png?v=' + VERSION,
      badge: './bet-icon-192.png?v=' + VERSION,
      data: { url: d.url || './' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  const diary = new URL(target).searchParams.get('diary') === 'today';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope)) {
          if (diary) c.postMessage({ type: 'open-diary' });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
