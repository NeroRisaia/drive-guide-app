'use strict';

const ANNOUNCE_M = 300;
const STORAGE = {
  muted: 'dg_muted',
  announced: 'dg_announced',
  wiki: 'dg_wiki',
  last: 'dg_last',
};
// 公開版: 自宅サーバーの /api/ は使わず、端末から Overpass API へ直接問い合わせる。CORS が開いている順に並べる。
const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// radii: 現在地（＝追従中の地図の中心）から近い順に問い合わせ、enough 件そろったらそこで止める。
// 取得範囲は最大でも半径3kmまで（全国・広域の一括取得はしない）。
const CATEGORIES = {
  sightseeing: {
    label: '観光スポット',
    mark: '観',
    filters: 'nwr[tourism~"^(attraction|viewpoint|artwork|museum|gallery)$"]AROUND;nwr[historic]AROUND;',
    radii: [1000, 3000],
    enough: 3,
  },
  toilets: {
    label: '公衆トイレ',
    mark: 'ト',
    filters: 'nwr[amenity=toilets]AROUND;',
    radii: [500, 1500, 3000],
    enough: 3,
  },
};
const FETCH_ORDER = ['toilets', 'sightseeing']; // 公衆トイレを最優先
const PIN_ORDER = { toilets: 2000 };
const OTHERS_DELAY_MS = 150; // トイレを先に走らせてから残りを並列で始める
const ALL_VIEW_LIMIT = 8; // 「すべて」表示の1カテゴリあたりの行数（全件はカテゴリのボタンで）
const LAST_ITEMS_MAX = 100; // 前回結果として端末に残す1カテゴリあたりの件数
const REFINE_MOVE_M = 300; // 概略位置と精密位置がこれ以上ずれたら取り直す
const REFINE_ACCURACY_M = 100;
const LOCAL_TOILET_MAX = 30; // 端末内検索で一覧に出す件数
const LOCAL_SEARCH_DEG = 0.45; // 端末内検索の範囲（約50km）
const LOCAL_UPDATE_M = 100; // この距離を動くごとに最寄りトイレを探し直す
const AHEAD_SPEED_MS = 3; // これより速ければ走行中とみなし、進行方向を使う
const AHEAD_ANGLE_DEG = 75; // 進行方向の左右この角度までを「前方」とする
const AHEAD_MAX_M = 5000; // 前方にこの距離以内が無ければ単純な最寄りを使う

const state = {
  category: 'all',
  items: [],
  pos: null,
  heading: null, // 走行中の進行方向（度）。停車中は null
  localPos: null,
  fetchPos: null,
  lastSaved: null,
  refined: false,
  run: 0,
  results: {}, // cat -> { items, radius, fetchedAt, source, loading, error }
  arrival: [], // 結果が届いたカテゴリの順
  selectedId: null,
  muted: localStorage.getItem(STORAGE.muted) === '1',
  announced: storedList(STORAGE.announced),
};

// 段階別の時刻（ページ読み込み開始からのミリ秒）。公開版では端末内に持つだけで、どこにも送らない。
const perf = { marks: {}, cats: {}, done: false };
window.__dgPerf = perf;
function mark(name) {
  if (perf.marks[name] == null) perf.marks[name] = Math.round(performance.now());
}
mark('appStart');

const el = {
  status: document.getElementById('status'),
  items: document.getElementById('items'),
  card: document.getElementById('card'),
  cardName: document.getElementById('cardName'),
  cardDistance: document.getElementById('cardDistance'),
  cardDescription: document.getElementById('cardDescription'),
  mapsLink: document.getElementById('mapsLink'),
  cardSource: document.getElementById('cardSource'),
  toiletNow: document.getElementById('toiletNow'),
  readNow: document.getElementById('readNow'),
  mute: document.getElementById('mute'),
  refresh: document.getElementById('refresh'),
};

const map = L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

let userMarker = null;

function centerOn(pos) {
  map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 15));
}

// ---------- 利用者の手動操作中・操作後5秒は追従を止める（作者の別アプリの駐車場マップと同じ仕様） ----------
// 「利用者の操作」とするのは、利用者の入力から直接届くイベントだけ（アプリ側の setView では発生しない）:
//   ドラッグ: Leaflet の dragstart / dragend（保険として、指・マウスを離した入力でも終了とする）
//   ピンチ: 地図上の touchstart（指2本以上）〜 指が1本以下になった touchend / touchcancel
//   ホイール・ダブルクリック（ダブルタップ）・＋－ボタン・キーボードの拡大縮小／移動: その入力1回ごと
// 押している間は止めたまま。タイマーの起点は「手を離した時点」で、5秒たったら追従を再開して現在地を中心に戻す。
const USER_FOLLOW_PAUSE_MS = 5000;
const userGestures = new Set();
let userPausedUntil = 0;
let userResumeTimer = null;
const gestureLog = []; // 動作確認用（端末内だけ。どこにも送らない）

function userPaused() {
  return userGestures.size > 0 || Date.now() < userPausedUntil;
}

function userGestureStart(kind) {
  userGestures.add(kind);
  clearTimeout(userResumeTimer);
  userResumeTimer = null;
  gestureLog.push({ t: Date.now(), event: 'start', kind });
}

function userGestureEnd(kind) {
  if (!userGestures.delete(kind) && kind !== 'instant') return;
  if (userGestures.size > 0) return; // まだ別の指・操作が続いている
  userPausedUntil = Date.now() + USER_FOLLOW_PAUSE_MS; // 手を離した時点から5秒
  clearTimeout(userResumeTimer);
  userResumeTimer = setTimeout(resumeAfterUserGesture, USER_FOLLOW_PAUSE_MS);
  gestureLog.push({ t: Date.now(), event: 'paused', kind });
}

// 押して離す区別がない入力は、その入力の時点を「手を離した時点」とする
function userInstantInput(kind) {
  if (userGestures.size > 0) return; // ドラッグ・ピンチ中なら、その終了時に5秒を数え始める
  gestureLog.push({ t: Date.now(), event: 'start', kind });
  userGestureEnd('instant');
}

function resumeAfterUserGesture() {
  userResumeTimer = null;
  if (userPaused()) return;
  gestureLog.push({ t: Date.now(), event: 'resumed' });
  if (state.pos) centerOn(state.pos);
}

map.on('dragstart', () => userGestureStart('drag'));
map.on('dragend', () => userGestureEnd('drag'));
function releaseDrag(e) {
  if (!userGestures.has('drag')) return;
  if (e.touches && e.touches.length > 0) return; // まだ指が残っている
  userGestureEnd('drag');
}
['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach((type) => {
  document.addEventListener(type, releaseDrag, { capture: true, passive: true });
});
window.addEventListener('blur', releaseDrag);
map.on('dblclick', () => userInstantInput('dblclick-zoom'));
map.on('boxzoomend', () => userInstantInput('box-zoom'));
map.on('keydown', (e) => {
  const key = e.originalEvent && e.originalEvent.key;
  if (['+', '-', '=', '_', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) userInstantInput('keyboard');
});
{
  const box = map.getContainer();
  let pinching = false;
  box.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2 && !pinching) {
      pinching = true;
      userGestureStart('pinch');
    }
  }, { passive: true });
  const pinchEnd = (e) => {
    if (pinching && e.touches.length < 2) {
      pinching = false;
      userGestureEnd('pinch');
    }
  };
  box.addEventListener('touchend', pinchEnd, { passive: true });
  box.addEventListener('touchcancel', pinchEnd, { passive: true });
  // ポップアップ内のホイールは Leaflet が伝播を止めるため、地図のホイール拡大縮小だけが届く
  box.addEventListener('wheel', () => userInstantInput('wheel'), { passive: true });
  // ＋－ボタンは Leaflet がボタン自身でクリックの伝播を止めるため、ボタンに直接付ける
  box.querySelectorAll('.leaflet-control-zoom a').forEach((btn) => {
    btn.addEventListener('click', () => userInstantInput('zoom-button'));
  });
}
const markers = new Map();
const pinIcons = {};

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function storedList(key) {
  const value = loadJson(key, []);
  return Array.isArray(value) ? value : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function haversine(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 全国の公衆トイレを端末に持つ。Service Worker のキャッシュから返るので圏外でも読める。
const localToilets = fetch('./data/toilets-jp.json', { signal: AbortSignal.timeout(5000) })
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    mark('localToiletsReady');
    return data && Array.isArray(data.points) ? data : null;
  })
  .catch(() => null);

function searchLocalToilets(data, pos) {
  const cosLat = Math.cos((pos.lat * Math.PI) / 180);
  const near = [];
  for (const point of data.points) {
    const dLat = point[0] / 1e5 - pos.lat;
    if (dLat > LOCAL_SEARCH_DEG || dLat < -LOCAL_SEARCH_DEG) continue;
    const dLon = (point[1] / 1e5 - pos.lon) * cosLat;
    if (dLon > LOCAL_SEARCH_DEG || dLon < -LOCAL_SEARCH_DEG) continue;
    near.push({ score: dLat * dLat + dLon * dLon, point });
  }
  near.sort((a, b) => a.score - b.score);
  return near.slice(0, LOCAL_TOILET_MAX).map(({ point }) => ({
    type: 'jp',
    id: `${point[0]}_${point[1]}`,
    lat: point[0] / 1e5,
    lon: point[1] / 1e5,
    tags: point[2] ? { name: point[2] } : {},
  }));
}

async function showLocalToilets(pos) {
  const data = await localToilets;
  if (!data) return false;
  const items = toItems(searchLocalToilets(data, pos), 'toilets');
  state.localPos = pos;
  resultFor('toilets').loading = false;
  commit('toilets', items, null, 'local');
  mark('localToiletsShown');
  return true;
}

function bearing(from, to) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// 走行中は通り過ぎた後方より、前方のトイレを優先する
function nearestToilet() {
  const result = state.results.toilets;
  if (!result || !result.items.length) return null;
  if (state.heading != null) {
    const ahead = result.items.find((item) => {
      if (item.distance > AHEAD_MAX_M) return false;
      const diff = Math.abs(bearing(state.pos, item) - state.heading) % 360;
      return Math.min(diff, 360 - diff) <= AHEAD_ANGLE_DEG;
    });
    if (ahead) return { item: ahead, ahead: true };
  }
  return { item: result.items[0], ahead: false };
}

function updateToiletButton() {
  const target = state.pos ? nearestToilet() : null;
  el.toiletNow.hidden = !target;
  if (!target) return;
  const { item, ahead } = target;
  el.toiletNow.textContent = `最寄りトイレへ案内（${ahead ? '前方 ' : ''}${formatDistance(item.distance)}）`;
  el.toiletNow.href = mapsUrl(item);
}

function mapsUrl(item) {
  return (
    'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
    encodeURIComponent(`${item.lat},${item.lon}`)
  );
}

function buildQuery(cat, lat, lon, radius = CATEGORIES[cat].radii[0]) {
  const around = `(around:${radius},${lat},${lon})`;
  return `[out:json][timeout:25];(${CATEGORIES[cat].filters.replaceAll('AROUND', around)});out center qt;`;
}

const FETCH_TIMEOUT_MS = 35000; // 1エンドポイントあたりの上限（公開版は自宅サーバーの待ち直しが無いため長め。公開 Overpass は混雑時12〜26秒かかった）
const HEDGE_DELAY_MS = 8000; // 応答が無ければこの間隔で次のエンドポイントも並行して問い合わせる（公開 Overpass に負担をかけすぎない間隔）
const WIKI_CACHE_MAX = 200;

// 端末から Overpass API へ直接問い合わせる。応答が無ければ HEDGE_DELAY_MS ごとに次のエンドポイントも
// 並行して試し、最初の成功を採用して残りは中断する。
async function fetchOverpass(query) {
  const stop = new AbortController();
  const attempt = async (url, index) => {
    await sleep(index * HEDGE_DELAY_MS);
    if (stop.signal.aborted) throw new Error('stopped');
    const one = new AbortController();
    const timer = setTimeout(() => one.abort(), FETCH_TIMEOUT_MS);
    stop.signal.addEventListener('abort', () => one.abort());
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: one.signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (/error/i.test(data.remark || '')) throw new Error('runtime');
      return data;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await Promise.any(OVERPASS_ENDPOINTS.map(attempt));
  } catch (error) {
    if (error.errors.some((e) => e.message === '400')) {
      throw new Error('Overpass がクエリを拒否しました（400）。');
    }
    throw new Error('Overpass API が混雑しています。少し後に再取得してください。');
  } finally {
    stop.abort();
  }
}

async function fetchSpots(cat, pos, radius) {
  const started = performance.now();
  const data = await fetchOverpass(buildQuery(cat, pos.lat, pos.lon, radius));
  return {
    elements: data.elements || [],
    meta: { source: 'direct', ms: Math.round(performance.now() - started) },
  };
}

function toItems(elements, cat = state.category) {
  const seen = new Set();
  const items = [];
  for (const e of elements) {
    const lat = e.lat ?? (e.center && e.center.lat);
    const lon = e.lon ?? (e.center && e.center.lon);
    if (lat == null || lon == null) continue;
    const tags = e.tags || {};
    const name = tags.name || tags['name:ja'] || CATEGORIES[cat].label;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      cat,
      name,
      lat,
      lon,
      tags: { description: tags.description },
      distance: state.pos ? haversine(state.pos, { lat, lon }) : null,
    });
  }
  return items.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

function sectionRow(cat) {
  const li = document.createElement('li');
  li.className = 'section';
  const button = document.createElement('button');
  button.type = 'button';
  const total = state.results[cat].items.length;
  button.textContent = `${CATEGORIES[cat].label} ${total}件`;
  button.addEventListener('click', () => setCategory(cat));
  li.appendChild(button);
  return li;
}

function renderList() {
  const rows = document.createDocumentFragment();
  const grouped = state.category === 'all';
  let section = null;
  let shown = 0;
  for (const item of state.items) {
    if (grouped && item.cat !== section) {
      section = item.cat;
      shown = 0;
      rows.appendChild(sectionRow(section));
    }
    if (grouped && shown >= ALL_VIEW_LIMIT) continue;
    shown += 1;
    const li = document.createElement('li');
    if (item.id === state.selectedId) li.classList.add('selected');
    const button = document.createElement('button');
    button.type = 'button';
    const title = document.createElement('span');
    title.textContent = item.name;
    const dist = document.createElement('span');
    dist.className = 'dist';
    dist.textContent = item.distance == null ? '' : ` (${formatDistance(item.distance)})`;
    button.append(title, dist);
    button.addEventListener('click', () => select(item.id));
    li.appendChild(button);
    rows.appendChild(li);
  }
  el.items.replaceChildren(rows);
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function pinIcon(cat) {
  if (!pinIcons[cat]) {
    pinIcons[cat] = L.divIcon({
      className: `spot-pin spot-${cat}`,
      html: CATEGORIES[cat].mark,
      iconSize: [28, 28],
      popupAnchor: [0, -14],
    });
  }
  return pinIcons[cat];
}

// 差分だけ更新する（カテゴリが届くたびに全ピンを作り直さない）
function renderMarkers() {
  const visible = new Set(state.items.map((item) => item.id));
  for (const [id, marker] of markers) {
    if (visible.has(id)) continue;
    marker.remove();
    markers.delete(id);
  }
  for (const item of state.items) {
    if (markers.has(item.id)) continue;
    const front = PIN_ORDER[item.cat] || 0; // 密集地でも急ぎのトイレが隠れないように
    const marker = L.marker([item.lat, item.lon], { icon: pinIcon(item.cat), zIndexOffset: front }).addTo(map);
    const popupContent = document.createElement('div');
    popupContent.textContent = item.name;
    marker.bindPopup(popupContent);
    marker.on('click', () => select(item.id));
    markers.set(item.id, marker);
  }
}

function viewItems() {
  const cats = state.category === 'all' ? state.arrival : [state.category];
  return cats.flatMap((cat) => (state.results[cat] ? state.results[cat].items : []));
}

function applyView() {
  state.items = viewItems();
  renderMarkers();
  renderList();
  updateCategoryButtons();
  updateToiletButton();
}

function updateCategoryButtons() {
  document.querySelectorAll('.cat').forEach((button) => {
    const cat = button.dataset.cat;
    const result = state.results[cat];
    if (cat === 'all' || !result) return;
    const count = result.items.length ? ` ${result.items.length}` : '';
    button.textContent = `${CATEGORIES[cat].label}${count}${result.loading ? '…' : ''}`;
  });
}

async function select(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  state.selectedId = id;
  el.card.hidden = false;
  el.cardName.textContent = item.name;
  el.cardDistance.textContent = item.distance == null ? '' : `距離 ${formatDistance(item.distance)}`;
  el.cardDescription.textContent = item.tags.description || '説明を取得中…';
  setCardSource(null);
  el.mapsLink.href = mapsUrl(item);
  renderList();
  const description = await describe(item);
  if (state.selectedId === id) {
    el.cardDescription.textContent = description;
    if (item.tags.description) setCardSource('osm');
    else if (item.cat !== 'toilets') setCardSource(wikiSource(item.name));
  }
  speak(`${item.name}。${description}`);
}

// 説明文の出典表示。Wikipedia の文章は CC BY-SA 4.0、OSM の description タグは ODbL。
const WIKI_TITLES = 'dg_wiki_titles';
function wikiSource(name) {
  const titles = loadJson(WIKI_TITLES, {});
  return titles[name] ? { wiki: titles[name] } : null;
}

function setCardSource(src) {
  const box = el.cardSource;
  box.replaceChildren();
  box.hidden = !src;
  if (!src) return;
  const link = (href, text) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  };
  if (src === 'osm') {
    box.append('説明の出典: © ', link('https://www.openstreetmap.org/copyright', 'OpenStreetMap'), ' contributors（ODbL）');
    return;
  }
  box.append(
    '説明の出典: ',
    link('https://ja.wikipedia.org/wiki/' + encodeURIComponent(src.wiki.replaceAll(' ', '_')), `Wikipedia日本語版「${src.wiki}」`),
    '（',
    link('https://creativecommons.org/licenses/by-sa/4.0/deed.ja', 'CC BY-SA 4.0'),
    '）',
  );
}

async function describe(item) {
  if (item.cat === 'toilets') return '公衆トイレです。'; // 検索語が同じになるため Wikipedia は引かない（圏外でも止まらない）
  if (item.tags.description) return item.tags.description;
  const cache = loadJson(STORAGE.wiki, {});
  const title = item.name;
  if (cache[title]) return cache[title];
  try {
    const search = await fetch(
      'https://ja.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=1&srsearch=' +
        encodeURIComponent(title),
    );
    const searchData = await search.json();
    const hit = (searchData.query && searchData.query.search || [])[0];
    if (!hit) return '無料情報源に説明が見つかりませんでした。';
    const page = await fetch(
      'https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&origin=*&titles=' +
        encodeURIComponent(hit.title),
    );
    const pageData = await page.json();
    const pages = (pageData.query && pageData.query.pages) || {};
    const extract = Object.values(pages)[0].extract || '';
    const text = extract.trim() || '説明が見つかりませんでした。';
    cache[title] = text;
    const titles = loadJson(WIKI_TITLES, {});
    titles[title] = hit.title; // 出典表示のため、どの記事から取ったかを残す
    const titleKeys = Object.keys(titles);
    if (titleKeys.length > WIKI_CACHE_MAX) delete titles[titleKeys[0]];
    localStorage.setItem(WIKI_TITLES, JSON.stringify(titles));
    const keys = Object.keys(cache);
    if (keys.length > WIKI_CACHE_MAX) delete cache[keys[0]];
    localStorage.setItem(STORAGE.wiki, JSON.stringify(cache));
    return text;
  } catch {
    return '説明の取得に失敗しました。';
  }
}

function speak(text) {
  if (state.muted) return;
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  window.speechSynthesis.speak(utterance);
}

function markAnnounced(id) {
  if (state.announced.includes(id)) return;
  state.announced.push(id);
  localStorage.setItem(STORAGE.announced, JSON.stringify(state.announced.slice(-500)));
}

function checkProximity() {
  if (!state.pos) return;
  // 「すべて」表示で読み上げるのは観光スポットだけ（トイレを走行中に次々読まない）
  const targets = state.category === 'all' ? state.items.filter((i) => i.cat === 'sightseeing') : state.items;
  for (const item of targets) {
    if (state.announced.includes(item.id)) continue;
    const distance = haversine(state.pos, { lat: item.lat, lon: item.lon });
    if (distance > ANNOUNCE_M) continue;
    markAnnounced(item.id);
    speak(`${item.name}。約${formatDistance(distance)}先です。`);
  }
}

function resultFor(cat) {
  if (!state.results[cat]) state.results[cat] = { items: [] };
  return state.results[cat];
}

function saveLast() {
  const pos = state.pos || state.lastSaved;
  if (!pos) return;
  const cats = {};
  for (const cat of FETCH_ORDER) {
    const result = state.results[cat];
    if (!result || !result.fetchedAt) continue;
    cats[cat] = {
      radius: result.radius,
      fetchedAt: result.fetchedAt,
      items: result.items.slice(0, LAST_ITEMS_MAX).map(({ id, name, lat, lon, tags }) => ({ id, name, lat, lon, tags })),
    };
  }
  try {
    localStorage.setItem(STORAGE.last, JSON.stringify({ pos, savedAt: Date.now(), cats }));
  } catch {
    // 容量超過でも表示は続ける
  }
}

function restoreLast() {
  const saved = loadJson(STORAGE.last, null);
  if (!saved || !saved.pos) {
    map.setView([35.6812, 139.7671], 14);
    return;
  }
  state.lastSaved = saved.pos;
  map.setView([saved.pos.lat, saved.pos.lon], 15);
  for (const cat of FETCH_ORDER) {
    const stored = saved.cats && saved.cats[cat];
    if (!stored || !Array.isArray(stored.items)) continue;
    state.results[cat] = {
      radius: stored.radius,
      fetchedAt: stored.fetchedAt,
      source: stored.radius ? 'restored' : 'local',
      items: stored.items.map((item) => ({ ...item, cat, distance: haversine(saved.pos, item) })),
    };
    if (stored.items.length) state.arrival.push(cat);
  }
  if (!state.arrival.length) return;
  applyView();
  mark('restoredShown');
  setStatus(`前回の結果を表示中（${formatAge(saved.savedAt)}）。現在地を確認しています…`);
}

function formatAge(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}時間前`;
  return `${Math.round(minutes / 1440)}日前`;
}

function updateDistances() {
  for (const result of Object.values(state.results)) {
    for (const item of result.items) item.distance = haversine(state.pos, item);
    result.items.sort((a, b) => a.distance - b.distance);
  }
}

function updateStatus() {
  const parts = [];
  let failed = false;
  for (const cat of FETCH_ORDER) {
    const result = state.results[cat];
    if (!result) continue;
    const { label } = CATEGORIES[cat];
    if (result.loading && !result.items.length) {
      parts.push(`${label} 取得中…`);
    } else if (result.error) {
      failed = true;
      parts.push(`${label} 取得失敗${result.items.length ? `（前回の${result.items.length}件を表示）` : ''}`);
    } else {
      if (result.source === 'local') {
        parts.push(`${label} ${result.items.length}件（最寄り ${result.items.length ? formatDistance(result.items[0].distance) : 'なし'}）`);
        continue;
      }
      const old = result.source === 'stale' ? '・古いデータ' : '';
      const more = result.loading ? ' 更新中…' : '';
      parts.push(`${label} ${result.items.length}件（${result.radius}m以内${old}）${more}`);
    }
  }
  setStatus(parts.join(' / ') + (failed ? '。少し後に再取得してください。' : ''));
}

function commit(cat, items, radius, source) {
  const result = resultFor(cat);
  Object.assign(result, { items, radius, source, fetchedAt: Date.now(), error: null });
  if (!state.arrival.includes(cat)) state.arrival.push(cat);
  applyView();
  updateStatus();
  saveLast();
  checkProximity();
}

async function loadCategory(cat, pos, run, force) {
  const { radii, enough } = CATEGORIES[cat];
  const result = resultFor(cat);
  const record = (perf.cats[cat] = perf.cats[cat] || { steps: [] });
  if (cat === 'toilets' && (await showLocalToilets(pos))) {
    if (run === state.run) updateStatus();
    record.firstShown = record.firstShown || Math.round(performance.now());
    record.steps.push({ source: 'local', count: result.items.length, at: Math.round(performance.now()) });
    mark('firstResult');
    return;
  }
  try {
    for (const radius of radii) {
      const started = performance.now();
      const data = await fetchSpots(cat, pos, radius, force);
      if (run !== state.run) return;
      const received = performance.now();
      const items = toItems(data.elements || [], cat).filter((i) => i.distance == null || i.distance <= radius);
      const isLast = radius === radii[radii.length - 1];
      const settled = items.length >= enough || isLast;
      result.loading = !settled;
      // 段階の途中で、すでに出ている一覧（前回結果など）を少ない件数で置き換えない
      if (settled || items.length >= result.items.length) commit(cat, items, radius, data.meta && data.meta.source);
      record.steps.push({
        radius,
        count: items.length,
        source: data.meta && data.meta.source,
        serverMs: data.meta && data.meta.ms,
        fetchMs: Math.round(received - started),
        renderMs: Math.round(performance.now() - received),
        at: Math.round(performance.now()),
      });
      if (record.firstShown == null) record.firstShown = Math.round(performance.now());
      mark('firstResult');
      if (settled) return;
    }
  } catch (error) {
    if (run !== state.run) return;
    result.loading = false;
    result.error = error.message;
    record.error = error.message;
    updateStatus();
  }
}

function reportPerf() {
  if (perf.done) return;
  const nav = performance.getEntriesByType('navigation')[0] || {};
  perf.nav = { ttfb: Math.round(nav.responseStart || 0), dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0) };
  mark('allDone');
  perf.done = true;
}

async function refresh({ force = false } = {}) {
  if (!state.pos) return;
  state.run += 1;
  const { run, pos } = state;
  state.fetchPos = pos;
  for (const cat of FETCH_ORDER) {
    const result = resultFor(cat);
    result.loading = true;
    result.error = null;
  }
  updateStatus();
  updateCategoryButtons();
  const [first, ...others] = FETCH_ORDER;
  const firstDone = loadCategory(first, pos, run, force);
  await sleep(OTHERS_DELAY_MS);
  await Promise.all([firstDone, ...others.map((cat) => loadCategory(cat, pos, run, force))]);
  if (run !== state.run) return;
  applyView();
  updateStatus();
  reportPerf();
}

function setStatus(text) {
  el.status.textContent = text;
}

function updateMuteButton() {
  el.mute.setAttribute('aria-pressed', String(state.muted));
  el.mute.textContent = state.muted ? 'ミュート: ON' : 'ミュート: OFF';
}

function onPosition(position, source) {
  const pos = { lat: position.coords.latitude, lon: position.coords.longitude };
  const accurate = position.coords.accuracy <= REFINE_ACCURACY_M;
  const { heading, speed } = position.coords;
  state.heading = speed >= AHEAD_SPEED_MS && Number.isFinite(heading) ? heading : null;
  const first = state.pos == null;
  state.pos = pos;
  mark('geoFix');
  perf.geoSource = perf.geoSource || source;
  if (accurate) mark('geoAccurate');
  if (!userMarker) userMarker = L.marker([pos.lat, pos.lon]).addTo(map);
  if (!userPaused()) centerOn(pos); // 追従（手動操作中・手を離してから5秒は止める）
  if (!first && state.localPos && haversine(state.localPos, pos) >= LOCAL_UPDATE_M) showLocalToilets(pos);
  else if (!first) updateToiletButton();
  if (first) {
    state.refined = accurate;
    updateDistances();
    applyView();
    refresh();
  } else if (!state.refined && accurate) {
    state.refined = true;
    if (haversine(state.fetchPos, pos) >= REFINE_MOVE_M) refresh();
    else checkProximity();
  } else {
    checkProximity();
  }
}

function startGeolocation() {
  if (!('geolocation' in navigator)) {
    setStatus('この端末では位置情報を取得できません。');
    return;
  }
  // GPS の測位を待たず、まず端末が持っている概略位置で検索を始める。
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (state.pos == null) onPosition(position, 'coarse');
    },
    () => {},
    { enableHighAccuracy: false, maximumAge: 600000, timeout: 5000 },
  );
  navigator.geolocation.watchPosition(
    (position) => onPosition(position, 'gps'),
    () => {
      if (state.pos) return;
      setStatus(state.arrival.length ? '位置情報を取得できないため、前回の結果を表示しています。' : '位置情報を取得できないため、現在地は表示していません。ブラウザや端末の設定で位置情報を許可すると使えます。');
    },
    { enableHighAccuracy: true, maximumAge: 10000 },
  );
}

function setCategory(cat) {
  document.querySelectorAll('.cat').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === cat)));
  state.category = cat;
  state.selectedId = null;
  applyView();
  const result = state.results[cat];
  if (cat !== 'all' && (!result || result.error)) refresh();
}

document.querySelectorAll('.cat').forEach((button) => {
  button.addEventListener('click', () => setCategory(button.dataset.cat));
});

el.mute.addEventListener('click', () => {
  state.muted = !state.muted;
  localStorage.setItem(STORAGE.muted, state.muted ? '1' : '0');
  if (state.muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  updateMuteButton();
});

el.refresh.addEventListener('click', () => refresh({ force: true }));
el.readNow.addEventListener('click', () => {
  const item = state.items.find((i) => i.id === state.selectedId);
  if (item) speak(`${item.name}。${el.cardDescription.textContent}`);
});

updateMuteButton();
restoreLast();
startGeolocation();

window.__dg = { map, state, perf, gestureLog, userPaused, fetchSpots }; // 動作確認用

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => setStatus('キャッシュの準備に失敗しました。'));
}
