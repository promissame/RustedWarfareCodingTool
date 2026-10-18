/* 铁锈代码编写器 Service Worker：让装到主屏的应用能秒开界面 */
const CACHE = 'rt-coder-v28';
const SHELL = ['/', '/static/style.css', '/static/app.js',
               '/static/icons/icon-192.png', '/static/icons/icon-512.png',
               '/static/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 数据和文件操作永远走网络（本机服务），静态壳子走缓存优先
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/static/icons/')) {
    if (url.pathname.startsWith('/api/')) return;
  }
  if (url.pathname === '/' || url.pathname.startsWith('/static/')) {
    e.respondWith(
      caches.match(e.request).then(hit => {
        const net = fetch(e.request).then(r => {
          if (r && r.status === 200) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
          return r;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
