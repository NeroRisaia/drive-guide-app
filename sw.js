'use strict';

// 観光スポットマップ専用のキャッシュ（接頭辞 spotmap-pages-）。画面を更新したら番号を上げる。
// 同じ nerorisaia.github.io 上の他アプリ（タイムズ駐車場マップ・喫煙所マップ・つたえる）のキャッシュには触らない。
const CACHE_PREFIX = 'spotmap-pages-';
const CACHE = CACHE_PREFIX + 'v1';
// 同じURL（/drive-guide-app/）で以前公開していた旧版「ドライブガイド」のキャッシュ。このアプリ自身の旧版なので消してよい。
const OWN_OLD_PREFIXES = ['driveguide-pages-'];
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
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
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

function isOwnOldCache(key) {
  if (key === CACHE) return false;
  return key.startsWith(CACHE_PREFIX) || OWN_OLD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter(isOwnOldCache).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// このアプリの範囲（scope = /drive-guide-app/）の同一オリジン GET だけをキャッシュする。
// 地図タイル・Overpass・Wikipedia は対象外。キャッシュがあれば即返し、裏で更新する（次回起動で反映）。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return; // 他アプリのパスには応答しない

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
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
