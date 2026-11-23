/* 排班管理 Service Worker（纯静态，可离线）
   - 静态资源：网络优先，失败回退缓存
   - 全部使用相对路径，兼容 GitHub Pages 的 /repo/ 子路径
*/
const VERSION = 'v26';
const CACHE = `schedule-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './xlsx.full.min.js',
  './store.js',
  './stats.js',
  './excel_parse.js',
  './importer.js',
  './local_api.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(ASSETS.map((a) => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求：先网络（拿最新入口），离线回退缓存的 index
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html') || Response.error()))
    );
    return;
  }

  // 静态资源：网络优先，失败用缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Response.error()))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
