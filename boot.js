'use strict';

// 起動を速くするための先読み（index.html の head で、地図ライブラリより先に実行する）。
// 地図ライブラリ（leaflet.js）の読み込みを待たずに、データの一覧（index.json）・前回の位置の周りの地点ファイル・
// 端末が持っている概略の現在地の取得を始めておき、app.js がその結果をそのまま使う。
(() => {
  const TILES_PER_DEG = 4; // 同梱データの格子は緯度経度 0.25 度（app.js・tools/build_data.py と同じ）
  const RADIUS_FIRST = 3000; // 最初に読む範囲（app.js の RADII の3段目。足りなければ app.js が10kmまで読む）
  const json = (url) =>
    fetch(url, { signal: AbortSignal.timeout(15000) }).then((res) => {
      if (res.status === 404) return null; // その格子には地点がない（海上など）
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    });
  const tileKeys = (lat, lon, radius) => {
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
    const keys = [];
    for (let y = Math.floor((lat - dLat) * TILES_PER_DEG); y <= Math.floor((lat + dLat) * TILES_PER_DEG); y++) {
      for (let x = Math.floor((lon - dLon) * TILES_PER_DEG); x <= Math.floor((lon + dLon) * TILES_PER_DEG); x++) {
        keys.push(`${y / TILES_PER_DEG}_${x / TILES_PER_DEG}`);
      }
    }
    return keys;
  };
  const tiles = new Map(); // 格子 → Promise<{points} | null>
  const loadTile = (key) => {
    if (!tiles.has(key)) {
      const promise = json(`./data/spots/${key}.json`);
      promise.catch(() => {}); // 失敗は app.js 側で扱う
      tiles.set(key, promise);
    }
    return tiles.get(key);
  };
  let known = null; // index.json が届いていれば、地点のある格子の一覧（海上など地点のない格子は読まない）
  const prefetch = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    for (const key of tileKeys(lat, lon, RADIUS_FIRST)) if (!known || known[key]) loadTile(key);
  };

  const index = json('./data/spots/index.json');
  index.then((data) => {
    if (data) known = data.tiles;
  }, () => {});
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem('spotmap_lastpos'));
  } catch {
    // 保存データが読めなくても動作に影響しない
  }
  if (last) prefetch(last.lat, last.lon);

  // GPS の測位を待たず、端末が持っている概略位置で、その周りの地点ファイルの読み込みを始める
  const coarse = new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        prefetch(position.coords.latitude, position.coords.longitude);
        resolve(position);
      },
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 600000, timeout: 5000 },
    );
  });

  window.__spotBoot = { TILES_PER_DEG, RADIUS_FIRST, index, tiles, tileKeys, loadTile, coarse, last };
})();
