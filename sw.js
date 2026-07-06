/* 에스원 Answer — Service Worker
   HTML은 네트워크 우선(항상 최신), 정적 자산은 캐시 우선 + 오프라인 폴백 */
const CACHE = 'answer-v16';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './favicon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const accept = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || req.destination === 'document' || accept.includes('text/html');

  if (isHTML) {
    // 네트워크 우선: 항상 최신 화면을 받아옴 (오프라인이면 캐시)
    e.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return resp;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // 정적 자산: 캐시 우선
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
      try { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } catch (_) {}
      return resp;
    }))
  );
});
