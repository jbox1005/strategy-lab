// 전략랩 PWA 서비스워커
// 전략: cache-first (로컬 자산), 그리고 CDN 자산은 런타임 캐시 (offline 대비)

const VERSION = 'v1';
const CACHE_STATIC = `strategy-lab-static-${VERSION}`;
const CACHE_RUNTIME = `strategy-lab-runtime-${VERSION}`;

// 설치 시 사전 캐시할 로컬 자산
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/main.js',
  './js/config.js',
  './js/data/cities.js',
  './js/data/tiers.js',
  './js/data/exchanges.js',
  './js/data/demographics.js',
  './js/data/wpp_2026.json',
  './js/input/controls.js',
  './js/map/camera.js',
  './js/map/hexgrid.js',
  './js/map/projection.js',
  './js/map/renderer.js',
  './js/map/world.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

// ─── install: 사전 캐시 ──────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache =>
      // 일부 파일 실패해도 나머지는 진행 (Promise.allSettled)
      Promise.allSettled(PRECACHE.map(url =>
        cache.add(url).catch(err => console.warn('[sw] precache 실패:', url, err.message))
      ))
    ).then(() => self.skipWaiting())
  );
});

// ─── activate: 구버전 캐시 정리 ──────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_RUNTIME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── fetch: cache-first + 런타임 캐시 ─────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 외부 CDN(다른 origin)도 런타임 캐시
  const isCrossOrigin = url.origin !== self.location.origin;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;

      return fetch(req).then(net => {
        // 성공 응답만 캐시 (불투명/오류는 패스)
        if (net && net.status === 200 && net.type !== 'opaqueredirect') {
          const targetCache = isCrossOrigin ? CACHE_RUNTIME : CACHE_STATIC;
          const clone = net.clone();
          caches.open(targetCache).then(c => c.put(req, clone)).catch(() => {});
        }
        return net;
      }).catch(() => {
        // 오프라인 + 캐시 미스 → HTML이면 index.html fallback
        if (req.destination === 'document') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
