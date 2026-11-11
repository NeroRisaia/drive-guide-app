'use strict';

// キャッシュ名はこのアプリ専用（接頭辞 driveguide-pages-）。同じ nerorisaia.github.io 上の他アプリのキャッシュには触らない。
// データ・画面を更新したら番号を上げる。
const CACHE_PREFIX = 'driveguide-pages-';
const CACHE = CACHE_PREFIX + 'v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './data/toilets-jp.json', // 全国の公衆トイレ。圏外でも検索できるよう端末に持つ
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        for (const path of SHELL) {
          try {
            await cache.add(new Request(path, { cache: 'reload' }));
          } catch {
            // 1ファイル失敗しても install 全体を中止しない
          }
        }
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// このアプリの範囲（scope = /drive-guide-app/）の同一オリジン GET だけをキャッシュする。地図タイル・Overpass・Wikipedia は対象外。
// キャッシュがあれば即返し、裏で更新する（通信が弱くても起動が待たされない）。
// 更新は次回起動で反映される。新しい sw.js が入ったときは CACHE 名を変えて全体を入れ替える。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return; // 他アプリのパスには応答しない

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request, { signal: AbortSignal.timeout(8000) }).then((response) => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      });
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network.catch(() => new Response('オフラインです', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    }),
  );
});
