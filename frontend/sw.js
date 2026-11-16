/* 排班管理 Service Worker
   - 静态资源：网络优先，离线回退缓存（保证更新后刷新即生效）
   - API：网络优先，失败时回退缓存（离线只读）
*/
const VERSION = 'v6';
const STATIC_CACHE = `schedule-static-${VERSION}`;
const API_CACHE = `schedule-api-${VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/static/app.css',
  '/static/app.js',
  '/manifest.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== STATIC_CACHE && k !== API_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API：网络优先，离线回退到上次成功结果
  if (url.pathname.startsWith('/api/')) {
    // 备份下载不缓存
    if (url.pathname === '/api/backup') return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || new Response(
          JSON.stringify({ detail: '离线状态，无法获取最新数据' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )))
    );
    return;
  }

  // 导航请求：网络优先，失败用缓存首页
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/').then((r) => r || Response.error()))
    );
    return;
  }

  // 静态资源：网络优先（保证代码/样式更新立即生效），失败用缓存
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || Response.error()))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
