'use strict';

// 観光スポットマップ（非公式）
// 現在地の周辺の観光スポットを、端末から Overpass API（OpenStreetMap）へ直接問い合わせて表示する。
// 説明文は OpenStreetMap の description タグ、無ければ Wikipedia 日本語版（記事ごとに出典を表示）。
// 経路案内は Google マップを開く。地図の追従・「最寄り」はタイムズ駐車場マップ（作者の別アプリ）と同じ仕様。

const STORAGE = {
  wiki: 'spotmap_wiki', // 名称 → { title, text }
  grid: 'spotmap_grid', // 周辺エリア（格子）ごとの取得結果
  endpoint: 'spotmap_endpoint', // 前回応答が返った Overpass
};
const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// 取得対象（観光スポットとして妥当なものに絞る）。
// 展望地は名称の無いものも多いので名称なしでも取る。それ以外は名称のあるものだけ。
const ACCESS_OK = '[access!~"^(private|no)$"]';
const FILTERS = [
  `nwr["tourism"~"^(attraction|museum|gallery|zoo|aquarium|theme_park)$"]["name"]${ACCESS_OK}AROUND;`,
  `nwr["tourism"="viewpoint"]${ACCESS_OK}AROUND;`,
  `nwr["historic"="castle"]["name"]${ACCESS_OK}AROUND;`,
].join('');
const KIND_LABELS = {
  attraction: '観光名所',
  museum: '博物館',
  gallery: '美術館',
  viewpoint: '展望地',
  zoo: '動物園',
  aquarium: '水族館',
  theme_park: 'テーマパーク',
  castle: '城・城跡',
};
// 現在地から近い順に問い合わせ、ENOUGH 件そろったらそこで止める。最大でも半径3km（広域の一括取得はしない）。
const RADII = [600, 1500, 3000]; // 開始は半径600m。少なければ段階的に広げる
const LIMITS = [40, 60, 60]; // 1回の取得件数の上限
const ENOUGH = 3;
const PARALLEL_START = 2; // 最初から並行して問い合わせるエンドポイント数
const HEDGE_DELAY_MS = 4000; // 応答が無ければこの間隔で次のエンドポイントも追加する
const ATTEMPT_TIMEOUT_MS = 30000; // 1回の問い合わせの上限
const TOTAL_DEADLINE_MS = 45000; // 1段階の上限。超えたら失敗として「再取得」を案内する
const FAST_FAIL_MS = 5000; // これより早く返った 429/502/503/504 は混雑による門前払いとみなす
const FAST_FAIL_WAIT_MS = 1500;
const FAST_FAIL_RETRIES = 2;
const GRID_DEG = 0.01; // 端末キャッシュの格子（緯度経度0.01度、約1km）
const CACHE_NEAR_M = 800; // 取得地点がこの距離以内のキャッシュを使う
const GRID_FRESH_MS = 60 * 60 * 1000; // 1時間以内のキャッシュは取り直さない
const GRID_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日を過ぎたキャッシュは捨てる
const GRID_MAX = 40; // 保存するマスの数の上限（古いものから消す）
const GRID_ITEMS_MAX = 60;
const PREFETCH_COUNT = 3; // 説明文を裏側で先読みするのは最寄りの3件だけ
const PREFETCH_DELAY_MS = 3000;
const REFINE_ACCURACY_M = 100;
const REFINE_MOVE_M = 300; // 概略位置と精密位置がこれ以上ずれたら取り直す
const REFETCH_MOVE_M = 2000; // 前回の取得地点からこれ以上動いたら取り直す
const LIST_MAX = 30;
const WIKI_CACHE_MAX = 200;
const LOCATED_ZOOM = 15;
const NO_NAME_VIEWPOINT = '展望地（名称の登録なし）';

const el = {
  status: document.getElementById('status'),
  geoStatus: document.getElementById('geoStatus'),
  locate: document.getElementById('locate'),
  nearest: document.getElementById('nearest'),
  refresh: document.getElementById('refresh'),
  empty: document.getElementById('empty'),
  card: document.getElementById('card'),
  cardName: document.getElementById('cardName'),
  cardMeta: document.getElementById('cardMeta'),
  cardDescription: document.getElementById('cardDescription'),
  cardSource: document.getElementById('cardSource'),
  mapsLink: document.getElementById('mapsLink'),
  readNow: document.getElementById('readNow'),
  listTitle: document.getElementById('listTitle'),
  items: document.getElementById('items'),
};

const perf = { firstSpotMs: null, firstSource: null, endpoint: null }; // 動作確認用（端末内だけ。どこにも送らない）
const state = {
  pos: null,
  heading: null, // 走行中の進行方向（度）。停車中は null
  fetchPos: null,
  refined: false,
  run: 0,
  result: { items: [], radius: null, fetchedAt: null, source: null, loading: false, error: null },
  selectedId: null,
};

const map = L.map('map', { zoomControl: true }).setView([35.6812, 139.7671], 14);
// 「© OpenStreetMap contributors」を地図上に常時表示（Leaflet 標準のクレジット欄）
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

const markers = new Map();
const spotIcon = L.divIcon({ className: 'spot-pin', html: '観', iconSize: [28, 28], popupAnchor: [0, -14] });
let userMarker = null;

// ---------- 共通 ----------
function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 容量超過・保存不可でも表示は続ける
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function haversine(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function formatAge(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}時間前`;
  return `${Math.round(minutes / 1440)}日前`;
}

function setStatus(text) {
  el.status.textContent = text;
}

function setGeoStatus(text) {
  el.geoStatus.hidden = !text;
  el.geoStatus.textContent = text;
}

function mapsUrl(item) {
  return (
    'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
    encodeURIComponent(`${item.lat},${item.lon}`)
  );
}

function osmUrl(item) {
  const [type, id] = item.id.split('/');
  return `https://www.openstreetmap.org/${type}/${id}`;
}

// ---------- Overpass ----------
// 応答を軽くする: 必要なのは中心座標とタグだけ（メタ情報・形状は取らない）。件数に上限を付け、
// サーバーの受付を通りやすくするため timeout / maxsize も小さめにする。
function buildQuery(lat, lon, radius, limit) {
  const around = `(around:${radius},${lat},${lon})`;
  return `[out:json][timeout:20][maxsize:67108864];(${FILTERS.replaceAll('AROUND', around)});out tags center qt ${limit};`;
}

function endpointOrder() {
  // 前回応答が返ったエンドポイントを先頭にする
  let sticky = null;
  try {
    sticky = localStorage.getItem(STORAGE.endpoint);
  } catch {
    // 保存できない環境でも既定の順で問い合わせる
  }
  return OVERPASS_ENDPOINTS.includes(sticky) ? [sticky, ...OVERPASS_ENDPOINTS.filter((u) => u !== sticky)] : OVERPASS_ENDPOINTS;
}

// 最初から PARALLEL_START か所へ並行して問い合わせ、残りは HEDGE_DELAY_MS ごとに追加する。
// 1回の問い合わせは ATTEMPT_TIMEOUT_MS、1段階全体は TOTAL_DEADLINE_MS で打ち切る。
// 混雑ですぐ返る 429/502/503/504 は、同じエンドポイントへ少し待って再試行する（回数に上限あり）。
// 最初の成功を採用して残りは中断する。
async function fetchOverpass(query) {
  const stop = new AbortController();
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  const attempt = async (url, index) => {
    await sleep(index < PARALLEL_START ? 0 : (index - PARALLEL_START + 1) * HEDGE_DELAY_MS);
    for (let retry = 0; ; retry++) {
      if (stop.signal.aborted) throw new Error('stopped');
      const left = deadline - Date.now();
      if (left < 1000) throw new Error('deadline');
      const one = new AbortController();
      const timer = setTimeout(() => one.abort(), Math.min(ATTEMPT_TIMEOUT_MS, left));
      const onStop = () => one.abort();
      stop.signal.addEventListener('abort', onStop);
      const started = Date.now();
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: one.signal });
        if (!res.ok) {
          const busy = [429, 502, 503, 504].includes(res.status) && Date.now() - started < FAST_FAIL_MS;
          if (busy && retry < FAST_FAIL_RETRIES) {
            await sleep(FAST_FAIL_WAIT_MS);
            continue;
          }
          throw new Error(String(res.status));
        }
        const data = await res.json();
        if (/error/i.test(data.remark || '')) throw new Error('runtime');
        try {
          localStorage.setItem(STORAGE.endpoint, url);
        } catch {
          // 保存できなくても結果は使う
        }
        perf.endpoint = url;
        return data;
      } finally {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', onStop);
      }
    }
  };
  try {
    return await Promise.any(endpointOrder().map(attempt));
  } catch (error) {
    if (error.errors && error.errors.some((e) => e.message === '400')) throw new Error('Overpass がクエリを拒否しました（400）。');
    throw new Error('Overpass API が混雑しています。少し後に「再取得」を押してください。');
  } finally {
    stop.abort();
  }
}

function kindOf(tags) {
  if (tags.tourism && KIND_LABELS[tags.tourism]) return tags.tourism;
  if (tags.historic === 'castle') return 'castle';
  return 'attraction';
}

function toItems(elements) {
  const seen = new Set();
  const items = [];
  for (const e of elements) {
    const lat = e.lat ?? (e.center && e.center.lat);
    const lon = e.lon ?? (e.center && e.center.lon);
    if (lat == null || lon == null) continue;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = e.tags || {};
    const named = tags['name:ja'] || tags.name;
    const kind = kindOf(tags);
    items.push({
      id,
      name: named || NO_NAME_VIEWPOINT,
      named: Boolean(named),
      kind,
      lat,
      lon,
      tags: { description: tags.description, wikipedia: tags.wikipedia },
    });
  }
  return items;
}

function withDistances(items, from) {
  for (const item of items) item.distance = from ? haversine(from, item) : null;
  return items.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

// ---------- 端末側キャッシュ（周辺エリア単位） ----------
// 取得地点の座標を GRID_DEG（約1km）の格子に丸めたマスごとに、取得結果を端末に保存する。
// 同じ周辺を再び開いたら、まずキャッシュを即表示し、古ければ裏側で取り直す。
function cellKey(pos) {
  return `${Math.round(pos.lat / GRID_DEG)}_${Math.round(pos.lon / GRID_DEG)}`;
}

function loadGrid() {
  const grid = loadJson(STORAGE.grid, {});
  const now = Date.now();
  for (const [key, entry] of Object.entries(grid)) {
    if (!entry || !entry.pos || !Array.isArray(entry.items) || now - entry.fetchedAt > GRID_TTL_MS) delete grid[key];
  }
  return grid;
}

function saveToGrid(pos, radius, items) {
  const grid = loadGrid();
  grid[cellKey(pos)] = {
    pos,
    radius,
    fetchedAt: Date.now(),
    items: items.slice(0, GRID_ITEMS_MAX).map(({ id, name, named, kind, lat, lon, tags }) => ({ id, name, named, kind, lat, lon, tags })),
  };
  const keys = Object.keys(grid).sort((a, b) => grid[a].fetchedAt - grid[b].fetchedAt);
  while (keys.length > GRID_MAX) delete grid[keys.shift()];
  saveJson(STORAGE.grid, grid);
}

// 現在地のマスと周りの8マスから、取得地点が CACHE_NEAR_M 以内のものを選ぶ（近いもの優先）
function findCached(pos) {
  const grid = loadGrid();
  const [y, x] = cellKey(pos).split('_').map(Number);
  let best = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const entry = grid[`${y + dy}_${x + dx}`];
      if (!entry) continue;
      const d = haversine(pos, entry.pos);
      if (d > CACHE_NEAR_M) continue;
      if (!best || d < best.d) best = { entry, d };
    }
  }
  return best && best.entry;
}

function latestCached() {
  const entries = Object.values(loadGrid());
  return entries.sort((a, b) => b.fetchedAt - a.fetchedAt)[0] || null;
}

// キャッシュを表示する（同じ周辺の新しい取得結果がすでに出ていればそちらを優先）
function showCached(entry, from) {
  if (!entry) return false;
  const r = state.result;
  if (r.source === 'live' && state.fetchPos && haversine(state.fetchPos, entry.pos) < CACHE_NEAR_M) return false;
  Object.assign(r, {
    items: withDistances(entry.items.map((i) => ({ ...i })), from || entry.pos),
    radius: entry.radius,
    fetchedAt: entry.fetchedAt,
    source: 'cache',
    error: null,
  });
  render();
  updateStatus();
  return true;
}

// 現在地の周辺を表示する: キャッシュがあれば即表示、無いか古ければ取得する
function loadAround(pos) {
  const entry = findCached(pos);
  if (entry) showCached(entry, pos);
  if (entry && Date.now() - entry.fetchedAt < GRID_FRESH_MS) {
    state.fetchPos = entry.pos; // 新しいキャッシュなので取り直さない（「再取得」では取り直す）
    prefetchDescriptions();
    return;
  }
  refresh();
}

// ---------- 取得 ----------
async function refresh() {
  if (!state.pos) return;
  state.run += 1;
  const { run, pos } = state;
  state.fetchPos = pos;
  const result = state.result;
  result.loading = true;
  result.error = null;
  updateStatus();
  try {
    for (let step = 0; step < RADII.length; step++) {
      const radius = RADII[step];
      const data = await fetchOverpass(buildQuery(pos.lat, pos.lon, radius, LIMITS[step]));
      if (run !== state.run) return;
      // Overpass の応答が届いた時点で、説明文を待たずに近い順でピンと一覧を出す
      const items = withDistances(toItems(data.elements || []), pos).filter((i) => i.distance <= radius);
      const settled = items.length >= ENOUGH || step === RADII.length - 1;
      // 段階の途中で、すでに出ている一覧（キャッシュなど）を少ない件数で置き換えない
      if (settled || items.length >= result.items.length) {
        Object.assign(result, { items, radius, source: 'live', fetchedAt: Date.now() });
        if (state.pos) withDistances(result.items, state.pos);
        render();
      }
      result.loading = !settled;
      updateStatus();
      if (settled) {
        saveToGrid(pos, radius, items);
        prefetchDescriptions();
        return;
      }
    }
  } catch (error) {
    if (run !== state.run) return;
    result.loading = false;
    result.error = error.message;
    updateStatus();
  }
}

function updateStatus() {
  const r = state.result;
  let text;
  if (r.loading && !r.items.length) {
    text = '観光スポットを取得中…（公開サーバーが混雑していると数十秒かかります）';
  } else if (r.error) {
    text = `取得に失敗しました${r.items.length ? `（端末に保存した結果${r.items.length}件を表示・${formatAge(r.fetchedAt)}）` : ''}。${r.error}`;
  } else if (r.fetchedAt) {
    const old = r.source === 'cache' ? `・端末に保存した結果（${formatAge(r.fetchedAt)}）` : '';
    text = `観光スポット ${r.items.length}件（${formatDistance(r.radius)}以内${old}）${r.loading ? ' 更新中…' : ''}`;
  } else {
    text = state.pos ? '観光スポットを取得中…' : '現在地を取得しています…';
  }
  setStatus(text);
  el.empty.hidden = !(r.fetchedAt && !r.loading && !r.error && r.items.length === 0 && r.source === 'live');
}

// 起動直後（位置情報の前）は、最後に保存した周辺を表示しておく
function restoreLast() {
  try {
    localStorage.removeItem('spotmap_last'); // このアプリの前の版の保存データ（旧形式）
  } catch {
    // 消せなくても動作に影響しない
  }
  const entry = latestCached();
  if (!entry) return;
  map.setView([entry.pos.lat, entry.pos.lon], LOCATED_ZOOM);
  showCached(entry);
}

// 説明文はタップ時に取得するのが基本。裏側で先読みするのは最寄りの PREFETCH_COUNT 件だけで、
// ピン・一覧を出した後に1件ずつ順番に取得する（一覧の表示は待たせない）。
const prefetched = new Set();
let prefetchTimer = null;
function prefetchDescriptions() {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(async () => {
    const targets = state.result.items.filter((i) => i.named && !i.tags.description && !prefetched.has(i.id)).slice(0, PREFETCH_COUNT);
    for (const item of targets) {
      prefetched.add(item.id);
      await describe(item);
    }
  }, PREFETCH_DELAY_MS);
}

// ---------- 描画 ----------
function render() {
  if (perf.firstSpotMs == null && state.result.items.length) {
    perf.firstSpotMs = Math.round(performance.now()); // ページ読み込み開始から最初のスポットを出すまで
    perf.firstSource = state.result.source;
  }
  renderMarkers();
  renderList();
  updateNearestButton();
}

function popupNode(item) {
  const wrap = document.createElement('div');
  wrap.className = 'popup';
  const t = document.createElement('p');
  t.className = 'name';
  const strong = document.createElement('strong');
  strong.textContent = item.name;
  t.appendChild(strong);
  const kind = document.createElement('p');
  kind.className = 'note';
  kind.textContent = KIND_LABELS[item.kind];
  const dist = document.createElement('p');
  dist.className = 'pop-dist';
  dist.textContent = state.pos
    ? `現在地から 約${formatDistance(haversine(state.pos, item))}（直線距離）`
    : '現在地からの距離: 現在地が取得できていません';
  const go = document.createElement('a');
  go.className = 'popup-go';
  go.href = mapsUrl(item);
  go.target = '_blank';
  go.rel = 'noopener';
  go.textContent = 'Googleマップで案内（車）';
  const edit = document.createElement('a');
  edit.className = 'osm-edit';
  edit.href = osmUrl(item);
  edit.target = '_blank';
  edit.rel = 'noopener';
  edit.textContent = 'OpenStreetMap でこの地点を見る・修正する';
  wrap.append(t, kind, dist, go, edit);
  return wrap;
}

function itemById(id) {
  return state.result.items.find((i) => i.id === id) || null;
}

// 差分だけ更新する
function renderMarkers() {
  const want = new Set(state.result.items.map((i) => i.id));
  for (const [id, marker] of markers) {
    if (want.has(id)) continue;
    marker.remove();
    markers.delete(id);
  }
  for (const item of state.result.items) {
    if (markers.has(item.id)) continue;
    const marker = L.marker([item.lat, item.lon], { icon: spotIcon, keyboard: true, title: item.name });
    marker.bindPopup(() => popupNode(itemById(item.id) || item), { maxWidth: 280 });
    marker.on('click', () => showCard(item.id));
    marker.addTo(map);
    markers.set(item.id, marker);
  }
}

function renderList() {
  const from = state.pos || state.fetchPos;
  el.listTitle.textContent = state.pos ? '現在地から近い観光スポット' : '近くの観光スポット';
  const rows = document.createDocumentFragment();
  const items = state.result.items.slice(0, LIST_MAX);
  if (!items.length && state.result.fetchedAt && !state.result.loading) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'この付近に登録された観光スポットがありません（OpenStreetMap に未登録の地点は表示されません）';
    rows.appendChild(li);
  }
  for (const item of items) {
    const li = document.createElement('li');
    if (item.id === state.selectedId) li.classList.add('selected');
    const button = document.createElement('button');
    button.type = 'button';
    const title = document.createElement('span');
    title.textContent = item.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = KIND_LABELS[item.kind];
    const dist = document.createElement('span');
    dist.className = 'dist';
    dist.textContent = from ? ` (${formatDistance(haversine(from, item))})` : '';
    button.append(title, dist, kind);
    button.addEventListener('click', () => {
      followPausedUntil = Date.now() + NEAREST_FOLLOW_PAUSE_MS; // 「最寄り」と同じく10秒間はポップアップを見られるようにする
      select(item.id);
    });
    li.appendChild(button);
    rows.appendChild(li);
  }
  el.items.replaceChildren(rows);
}

// 一覧・「最寄り」から: 地点へ移動してポップアップと説明を開く
function select(id) {
  const item = itemById(id);
  if (!item) return;
  // アニメーションなしで移動してから開く（近距離のパン中に開くと、ポップアップの自動スクロールがパンを打ち消すため）
  map.closePopup();
  map.setView([item.lat, item.lon], Math.max(map.getZoom(), 16), { animate: false });
  const marker = markers.get(id);
  if (marker) marker.openPopup();
  showCard(id);
}

// ---------- 説明文 ----------
async function showCard(id) {
  const item = itemById(id);
  if (!item) return;
  state.selectedId = id;
  el.card.hidden = false;
  el.cardName.textContent = item.name;
  el.cardMeta.textContent = `${KIND_LABELS[item.kind]}${state.pos ? `・現在地から約${formatDistance(haversine(state.pos, item))}` : ''}`;
  el.cardDescription.textContent = '説明を取得中…';
  el.mapsLink.href = mapsUrl(item);
  setCardSource(null);
  renderList();
  const { text, source } = await describe(item);
  if (state.selectedId !== id) return;
  el.cardDescription.textContent = text;
  setCardSource(source);
}

function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

// 説明文の出典表示。Wikipedia の文章は CC BY-SA 4.0、OSM の description タグは ODbL。
function setCardSource(source) {
  const box = el.cardSource;
  box.replaceChildren();
  box.hidden = !source;
  if (!source) return;
  if (source === 'osm') {
    box.append('説明の出典: © ', link('https://www.openstreetmap.org/copyright', 'OpenStreetMap'), ' contributors（ODbL 1.0）');
    return;
  }
  box.append(
    '説明の出典: ',
    link('https://ja.wikipedia.org/wiki/' + encodeURIComponent(source.wiki.replaceAll(' ', '_')), `Wikipedia日本語版「${source.wiki}」`),
    '（',
    link('https://creativecommons.org/licenses/by-sa/4.0/deed.ja', 'CC BY-SA 4.0'),
    '）',
  );
}

async function wikiExtract(title) {
  const res = await fetch(
    'https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&redirects=1&format=json&origin=*&titles=' +
      encodeURIComponent(title),
    { signal: AbortSignal.timeout(15000) },
  );
  const data = await res.json();
  const page = Object.values((data.query && data.query.pages) || {})[0] || {};
  if (page.missing !== undefined || !page.extract) return null;
  return { title: page.title || title, text: page.extract.trim() };
}

async function wikiSearch(name) {
  const res = await fetch(
    'https://ja.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=1&srsearch=' +
      encodeURIComponent(name),
    { signal: AbortSignal.timeout(15000) },
  );
  const data = await res.json();
  const hit = ((data.query && data.query.search) || [])[0];
  return hit ? wikiExtract(hit.title) : null;
}

async function describe(item) {
  if (item.tags.description) return { text: item.tags.description, source: 'osm' };
  if (!item.named) return { text: '名称の登録がないため、説明はありません。', source: null };
  const cache = loadJson(STORAGE.wiki, {});
  const key = item.tags.wikipedia || item.name;
  if (cache[key] && cache[key].title) return { text: cache[key].text, source: { wiki: cache[key].title } };
  try {
    // OpenStreetMap に Wikipedia 日本語版の記事が登録されていればそれを使い、無ければ名称で検索する
    const ja = /^ja:(.+)$/.exec(item.tags.wikipedia || '');
    const found = (ja && (await wikiExtract(ja[1]))) || (await wikiSearch(item.name));
    if (!found || !found.text) return { text: 'Wikipedia日本語版に説明が見つかりませんでした。', source: null };
    cache[key] = found;
    const keys = Object.keys(cache);
    if (keys.length > WIKI_CACHE_MAX) delete cache[keys[0]];
    saveJson(STORAGE.wiki, cache);
    return { text: found.text, source: { wiki: found.title } };
  } catch {
    return { text: '説明の取得に失敗しました。', source: null };
  }
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  window.speechSynthesis.speak(utterance);
}

el.readNow.addEventListener('click', () => {
  const item = itemById(state.selectedId);
  if (item) speak(`${item.name}。${el.cardDescription.textContent}`);
});

// ---------- 現在地の追従 ----------
// 位置が届くたびに現在地へ寄せる（追従）。次の2つの間は止める（タイムズ駐車場マップと同じ仕様）:
//   ・「最寄り」を押した直後の10秒間（ポップアップを押せるように。10秒後の次の測位から再開）
//   ・利用者が地図を手で動かしている間と、手を離してから5秒間（5秒たったら現在地へ戻す）
// 「現在地」ボタンで両方ともすぐ解除する。
const geoLog = []; // 動作確認用（端末内だけ。どこにも送らない）
function logGeo(event, detail = {}) {
  geoLog.push({ t: new Date().toISOString(), event, ...detail });
}

const NEAREST_FOLLOW_PAUSE_MS = 10000;
let followPausedUntil = 0;
function followPaused() {
  return Date.now() < followPausedUntil;
}

function centerOn(pos) {
  map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), LOCATED_ZOOM));
}

// 「利用者の操作」とするのは、利用者の入力から直接届くイベントだけ（アプリ側の setView では発生しない）:
//   ドラッグ: Leaflet の dragstart / dragend（保険として、指・マウスを離した入力でも終了とする）
//   ピンチ: 地図上の touchstart（指2本以上）〜 指が1本以下になった touchend / touchcancel
//   ホイール・ダブルクリック（ダブルタップ）・＋－ボタン・キーボードの拡大縮小／移動: その入力1回ごと
// 押している間は止めたまま。タイマーの起点は「手を離した時点」で、5秒たったら追従を再開して現在地を中心に戻す。
const USER_FOLLOW_PAUSE_MS = 5000;
const userGestures = new Set();
let userPausedUntil = 0;
let userResumeTimer = null;

function userPaused() {
  return userGestures.size > 0 || Date.now() < userPausedUntil;
}

function followBlocked() {
  return followPaused() || userPaused();
}

function userGestureStart(kind) {
  userGestures.add(kind);
  clearTimeout(userResumeTimer);
  userResumeTimer = null;
  logGeo('user-gesture-start', { kind });
}

function userGestureEnd(kind) {
  if (!userGestures.delete(kind) && kind !== 'instant') return;
  if (userGestures.size > 0) return; // まだ別の指・操作が続いている
  userPausedUntil = Date.now() + USER_FOLLOW_PAUSE_MS; // 手を離した時点から5秒
  clearTimeout(userResumeTimer);
  userResumeTimer = setTimeout(resumeAfterUserGesture, USER_FOLLOW_PAUSE_MS);
  logGeo('user-follow-paused', { kind, ms: USER_FOLLOW_PAUSE_MS });
}

// 押して離す区別がない入力は、その入力の時点を「手を離した時点」とする
function userInstantInput(kind) {
  if (userGestures.size > 0) return; // ドラッグ・ピンチ中なら、その終了時に5秒を数え始める
  logGeo('user-gesture-start', { kind });
  userGestureEnd('instant');
}

function resumeAfterUserGesture() {
  userResumeTimer = null;
  if (userPaused()) return;
  if (followPaused()) return; // 「最寄り」後の10秒停止中なら、そちらの再開（次の測位）に任せる
  logGeo('follow-resumed', { by: 'user-timeout' });
  if (state.pos) centerOn(state.pos);
}

function cancelUserPause() {
  userGestures.clear();
  userPausedUntil = 0;
  clearTimeout(userResumeTimer);
  userResumeTimer = null;
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

// ---------- 現在地 ----------
const AHEAD_SPEED_MS = 3; // これより速ければ走行中とみなし、進行方向を使う
const AHEAD_ANGLE_DEG = 75; // 進行方向の左右この角度までを「前方」とする
const AHEAD_MAX_M = 5000; // 前方にこの距離以内が無ければ単純な最寄りを使う

function geoFailureText(error) {
  if (!window.isSecureContext) return 'このアドレスでは、ブラウザの安全上の制限により位置情報が使えないため、現在地は表示していません。';
  if (error && error.code === 1) return '位置情報の利用が許可されていないため、現在地は表示していません。ブラウザや端末の設定で許可すると使えます。';
  if (error && error.code === 3) return '現在地の測位に時間がかかっています。少し待ってから、もう一度「現在地」を押してください。';
  return '今は現在地を測位できませんでした。電波の届く場所で、もう一度「現在地」を押してください。';
}

function onPosition(position, source) {
  const pos = { lat: position.coords.latitude, lon: position.coords.longitude };
  const accurate = position.coords.accuracy <= REFINE_ACCURACY_M;
  const { heading, speed } = position.coords;
  state.heading = speed >= AHEAD_SPEED_MS && Number.isFinite(heading) ? heading : null;
  const first = state.pos == null;
  state.pos = pos;
  if (first) logGeo('ok', { source, accuracy: Math.round(position.coords.accuracy) });
  if (!userMarker) userMarker = L.marker([pos.lat, pos.lon], { title: '現在地' }).addTo(map);
  else userMarker.setLatLng([pos.lat, pos.lon]);
  if (!followBlocked()) centerOn(pos); // 追従（「最寄り」直後の10秒と、手動操作中・操作後5秒は除く）
  if (first) setGeoStatus('');
  withDistances(state.result.items, pos);
  render();
  if (first) {
    state.refined = accurate;
    loadAround(pos);
  } else if (!state.refined && accurate) {
    state.refined = true;
    if (haversine(state.fetchPos, pos) >= REFINE_MOVE_M) loadAround(pos);
  } else if (!state.result.loading && state.fetchPos && haversine(state.fetchPos, pos) >= REFETCH_MOVE_M) {
    loadAround(pos);
  }
}

let watching = false;
function startGeolocation() {
  if (!('geolocation' in navigator)) {
    setGeoStatus('この端末・ブラウザは位置情報に対応していないため、現在地は表示していません。');
    return;
  }
  if (watching) return;
  watching = true;
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
    (error) => {
      watching = false;
      logGeo('error', { code: error && error.code });
      if (!state.pos) setGeoStatus(geoFailureText(error));
    },
    { enableHighAccuracy: true, maximumAge: 10000 },
  );
}

// 「現在地」ボタン: 一時停止中でもすぐ追従に戻して現在地へ寄せる
el.locate.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    startGeolocation();
    return;
  }
  followPausedUntil = 0;
  cancelUserPause();
  logGeo('follow-resumed', { by: 'locate-button' });
  if (state.pos) centerOn(state.pos);
  setGeoStatus('現在地を取得しています…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      onPosition(position, 'button');
      centerOn(state.pos);
      setGeoStatus('');
    },
    (error) => setGeoStatus(state.pos ? '' : geoFailureText(error)),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
  );
  startGeolocation();
});

// ---------- 「最寄り」ボタン ----------
// 取得済みの観光スポットのうち現在地から最も近いもの。走行中（秒速3m以上で進行方向あり）は
// 5km 以内・左右75度以内の「前方」を優先。押すと地点へ移動してポップアップと説明を開き、10秒間だけ追従を止める。
function nearestSpot(pos) {
  if (!pos || !state.result.items.length) return null;
  const items = state.result.items.map((item) => ({ item, distance: haversine(pos, item) }));
  items.sort((a, b) => a.distance - b.distance);
  if (state.heading != null) {
    const ahead = items.find(({ item, distance }) => {
      if (distance > AHEAD_MAX_M) return false;
      const diff = Math.abs(bearing(pos, item) - state.heading) % 360;
      return Math.min(diff, 360 - diff) <= AHEAD_ANGLE_DEG;
    });
    if (ahead) return { ...ahead, ahead: true };
  }
  return { ...items[0], ahead: false };
}

function updateNearestButton() {
  const target = state.pos ? nearestSpot(state.pos) : null;
  el.nearest.textContent = target ? `最寄り（${target.ahead ? '前方 ' : ''}${formatDistance(target.distance)}）` : '最寄り';
}

function goNearest(pos, note) {
  const target = nearestSpot(pos);
  if (!target) {
    setGeoStatus(state.result.loading ? '観光スポットを取得中です。少し待ってから押してください。' : '現在地の周辺（半径3km以内）に、取得できた観光スポットがありません。');
    return;
  }
  setGeoStatus(note || '');
  followPausedUntil = Date.now() + NEAREST_FOLLOW_PAUSE_MS; // この間は測位が届いても現在地へ戻さない
  logGeo('nearest-ok', { id: target.item.id, distance: Math.round(target.distance), ahead: target.ahead });
  logGeo('follow-paused', { ms: NEAREST_FOLLOW_PAUSE_MS });
  select(target.item.id);
}

el.nearest.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    setGeoStatus('この端末・ブラウザは位置情報に対応していないため、現在地は表示していません。');
    return;
  }
  setGeoStatus('現在地を取得して、最寄りの観光スポットを探しています…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      followPausedUntil = Date.now() + NEAREST_FOLLOW_PAUSE_MS; // 測位で現在地へ戻らないよう先に止める
      onPosition(position, 'nearest');
      goNearest(state.pos);
    },
    (error) => {
      if (state.pos) {
        goNearest(state.pos, `${geoFailureText(error)} 前回の現在地から探しました。`);
        return;
      }
      setGeoStatus(geoFailureText(error));
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
  );
  startGeolocation();
});

el.refresh.addEventListener('click', () => {
  if (!state.pos) {
    setGeoStatus('現在地が取得できていないため、取得できません。');
    return;
  }
  refresh();
});

restoreLast();
startGeolocation();

window.__spotmap = { map, state, perf, geoLog, followPaused, userPaused, buildQuery }; // 動作確認用

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
}
