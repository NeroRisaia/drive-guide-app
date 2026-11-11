'use strict';

// 観光スポットマップ（非公式）
// OpenStreetMap から抽出した全国の観光スポットを、緯度経度0.25度の格子ごとの JSON としてアプリに同梱する。
// 現在地の周りの格子のファイルだけを読み込み、端末内で近い順に探して表示する（Overpass への問い合わせはしない）。
// 説明文は OpenStreetMap の description タグ、無ければ Wikipedia 日本語版（記事ごとに出典を表示）。
// 経路案内は Google マップを開く。地図の追従・「最寄り」はタイムズ駐車場マップ（作者の別アプリ）と同じ仕様。

const STORAGE = {
  wiki: 'spotmap_wiki', // 名称 → { title, text }
  lastPos: 'spotmap_lastpos', // 最後に表示した位置（起動直後、位置情報が届く前の表示用）
};
// このアプリの前の版が使っていた保存データ（端末キャッシュ・Overpass の記録）。起動時に消す。
const OLD_STORAGE_KEYS = ['spotmap_last', 'spotmap_grid', 'spotmap_endpoint'];

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
// 近い範囲から順に見て、ENOUGH 件以上あればその範囲までを表示する
const RADII = [600, 1500, 3000, 10000];
const ENOUGH = 3;
const ITEMS_MAX = 100; // 一覧・ピンに出す件数の上限（近い順）
const DATA_TIMEOUT_MS = 15000;
const PREFETCH_COUNT = 3; // 説明文を裏側で先読みするのは最寄りの3件だけ
const PREFETCH_DELAY_MS = 1500;
const REFINE_ACCURACY_M = 100;
const REFINE_MOVE_M = 300; // 概略位置と精密位置がこれ以上ずれたら探し直す
const REFETCH_MOVE_M = 300; // 前回探した地点からこれ以上動いたら探し直す（端末内の検索なので軽い）
const LIST_MAX = 30;
const WIKI_CACHE_MAX = 200;
const LOCATED_ZOOM = 15;
const NO_POSITION_FALLBACK_MS = 8000; // 現在地がこの時間内に届かなければ、地図の中心の周りを出す
const NO_NAME_VIEWPOINT = '展望地（名称の登録なし）';

const el = {
  status: document.getElementById('status'),
  dataInfo: document.getElementById('dataInfo'),
  aboutData: document.getElementById('aboutData'),
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

const perf = { firstSpotMs: null, firstSource: null }; // 動作確認用（端末内だけ。どこにも送らない）
const state = {
  pos: null,
  posAt: 0, // 最後に現在地が届いた時刻
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

// ---------- 同梱データ ----------
// data/spots/index.json: データ取得時点・種別の一覧・格子ごとの件数
// data/spots/<南端の緯度>_<西端の経度>.json: 緯度経度 0.25 度の格子ごとの地点
//   [緯度×10^5, 経度×10^5, 名称, 種別番号, Wikipedia日本語版の記事名, description, OSM要素ID]
// 読み込みは boot.js（head で先に実行）が始めている。index.json の到着を待たずに地点ファイルも並行して読み込む。
// Service Worker が読み込んだファイルを端末に保存するので、2回目以降は圏外でも読める。
const boot = window.__spotBoot;
const tiles = boot.tiles; // 格子 → Promise<{points} | null>（boot.js と共有）
const tileItems = new Map(); // 格子 → 変換済みの地点
let indexPromise = null;
let indexLoaded = null;

function loadIndex() {
  if (!indexPromise) {
    const first = boot.index;
    boot.index = null; // boot.js の分は1回だけ使う（失敗したら次は読み直す）
    indexPromise = (first || fetchIndex())
      .then((index) => {
        if (!index) throw new Error('404');
        showDataInfo(index);
        indexLoaded = index;
        return index;
      })
      .catch((error) => {
        indexPromise = null; // 次の「再取得」で読み直す
        throw error;
      });
  }
  return indexPromise;
}

function fetchIndex() {
  return fetch('./data/spots/index.json', { signal: AbortSignal.timeout(DATA_TIMEOUT_MS) }).then((res) => {
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  });
}

function showDataInfo(index) {
  const [y, m, d] = index.osm_date.split('-').map(Number);
  const when = `${y}年${m}月${d}日`;
  el.dataInfo.textContent = `データ: OpenStreetMap ${when}時点`;
  el.aboutData.textContent = `データ取得時点: ${when}（OpenStreetMap のデータベース時刻 ${index.osm_base}）。全国 ${index.total.toLocaleString('ja-JP')}件。`;
}

function pointToItem(p, kinds) {
  const [lat5, lon5, name, kindIndex, wiki, description, osm] = p;
  const type = { n: 'node', w: 'way', r: 'relation' }[osm[0]];
  return {
    id: `${type}/${osm.slice(1)}`,
    name: name || NO_NAME_VIEWPOINT,
    named: Boolean(name),
    kind: kinds[kindIndex] || 'attraction',
    lat: lat5 / 1e5,
    lon: lon5 / 1e5,
    tags: { description: description || undefined, wikipedia: wiki ? `ja:${wiki}` : undefined },
  };
}

// 失敗した格子は捨てて、次の「再取得」で読み直す
function loadTile(key) {
  const promise = boot.loadTile(key);
  return promise.catch((error) => {
    if (tiles.get(key) === promise) tiles.delete(key);
    throw error;
  });
}

function itemsOfTile(key, data, kinds) {
  if (!tileItems.has(key)) tileItems.set(key, data ? data.points.map((p) => pointToItem(p, kinds)) : []);
  return tileItems.get(key);
}

function withDistances(items, from) {
  for (const item of items) item.distance = from ? haversine(from, item) : null;
  return items.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

function referencePos() {
  if (state.pos) return state.pos;
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

// 半径 radius の円にかかる格子の地点を、近い順に返す
async function itemsAround(pos, radius) {
  const known = indexLoaded && indexLoaded.tiles; // 届いていれば、地点のない格子は読まない
  const pending = boot.tileKeys(pos.lat, pos.lon, radius).filter((key) => !known || known[key]).map((key) => {
    const promise = loadTile(key);
    promise.catch(() => {}); // index.json に無い格子（海上など）の失敗は使わない
    return [key, promise];
  });
  const index = await loadIndex();
  const lists = await Promise.all(
    pending.filter(([key]) => index.tiles[key]).map(([key, promise]) => promise.then((data) => itemsOfTile(key, data, index.kinds))),
  );
  return withDistances(lists.flat().map((item) => ({ ...item })), pos);
}

// 基準地点の周りを端末内で探して、近い順にピンと一覧を出す（説明文は待たない）
async function refresh() {
  state.run += 1;
  const run = state.run;
  const pos = referencePos();
  const result = state.result;
  result.loading = true;
  result.error = null;
  updateStatus();
  try {
    // まず半径3km分の格子だけを読み、そこで3件以上あれば表示する。足りなければ10km分を読む。
    // 地点ファイルの読み込みを先に始めてから index.json を待つ（往復を1回減らす）。
    let all = await itemsAround(pos, RADII[RADII.length - 2]);
    if (run !== state.run) return;
    let radius = RADII.find((r) => all.filter((i) => i.distance <= r).length >= ENOUGH);
    if (!radius) {
      all = await itemsAround(pos, RADII[RADII.length - 1]);
      if (run !== state.run) return;
      radius = RADII.find((r) => all.filter((i) => i.distance <= r).length >= ENOUGH) || RADII[RADII.length - 1];
    }
    const items = all.filter((i) => i.distance <= radius).slice(0, ITEMS_MAX);
    state.fetchPos = pos;
    Object.assign(result, { items, radius, source: 'bundled', fetchedAt: Date.now(), loading: false });
    if (state.pos) saveJson(STORAGE.lastPos, state.pos);
    render();
    updateStatus();
    prefetchDescriptions();
  } catch {
    if (run !== state.run) return;
    result.loading = false;
    result.error = 'データを読み込めませんでした。通信できる場所で「再取得」を押してください。';
    updateStatus();
  }
}

// 現在地が変わったときに呼ぶ（端末内の検索だけなので、すぐ終わる）
function loadAround() {
  refresh();
}

function updateStatus() {
  const r = state.result;
  let text;
  if (r.error) {
    text = `${r.error}${r.items.length ? `（前に表示した${r.items.length}件を表示中）` : ''}`;
  } else if (r.loading && !r.items.length) {
    text = '観光スポットのデータを読み込んでいます…';
  } else if (r.fetchedAt) {
    const where = state.pos ? '現在地から' : '地図の中心から';
    text = `観光スポット ${r.items.length}件（${where}${formatDistance(r.radius)}以内）`;
  } else {
    text = state.pos ? '観光スポットを探しています…' : '現在地を取得しています…';
  }
  setStatus(text);
  el.empty.hidden = !(r.fetchedAt && !r.loading && !r.error && r.items.length === 0);
}

// 起動直後（位置情報の前）は、最後に表示した位置の周りを出しておく。
// 前回の位置が無い初回は、関係のない地域（地図の初期位置）のデータを読まないよう、現在地を待つ。
function restoreLast() {
  for (const key of OLD_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 消せなくても動作に影響しない
    }
  }
  const last = boot.last;
  if (last && Number.isFinite(last.lat) && Number.isFinite(last.lon)) {
    map.setView([last.lat, last.lon], LOCATED_ZOOM);
    refresh();
  }
}

// 現在地が使えない・まだ届かないときは、地図の中心の周りを出す
function showAroundCenterIfNothing() {
  if (!state.pos && !state.result.fetchedAt && !state.result.loading) refresh();
}

// 位置情報が使えないあいだは、地図を動かした先の周りを探す
let moveTimer = null;
map.on('moveend', () => {
  if (state.pos) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (state.pos) return;
    const c = map.getCenter();
    if (state.fetchPos && haversine(state.fetchPos, { lat: c.lat, lon: c.lng }) < 50) return; // 同じ場所は探し直さない
    refresh();
  }, 300);
});

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
  // 検索で最上位の記事の冒頭を、1回の問い合わせで取る（検索 → 本文の2往復をまとめる）
  const res = await fetch(
    'https://ja.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=1&prop=extracts&exintro&explaintext&redirects=1&format=json&origin=*&gsrsearch=' +
      encodeURIComponent(name),
    { signal: AbortSignal.timeout(15000) },
  );
  const data = await res.json();
  const page = Object.values((data.query && data.query.pages) || {})[0];
  if (!page || !page.extract) return null;
  return { title: page.title, text: page.extract.trim() };
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
const NEAREST_FRESH_MS = 15000; // 「最寄り」で、これより新しい現在地は測り直さずに使う
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
  state.posAt = Date.now();
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
    showAroundCenterIfNothing();
    return;
  }
  if (watching) return;
  watching = true;
  // GPS の測位を待たず、まず端末が持っている概略位置で検索を始める。
  boot.coarse.then((position) => {
    if (position && state.pos == null) onPosition(position, 'coarse');
  });
  navigator.geolocation.watchPosition(
    (position) => onPosition(position, 'gps'),
    (error) => {
      watching = false;
      logGeo('error', { code: error && error.code });
      if (!state.pos) setGeoStatus(geoFailureText(error));
      showAroundCenterIfNothing();
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
  // 直前（NEAREST_FRESH_MS 以内）に届いた現在地があれば、測位を待たずにすぐ探す
  if (state.pos && Date.now() - state.posAt < NEAREST_FRESH_MS) {
    followPausedUntil = Date.now() + NEAREST_FOLLOW_PAUSE_MS;
    goNearest(state.pos);
    startGeolocation();
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
setTimeout(showAroundCenterIfNothing, NO_POSITION_FALLBACK_MS);

window.__spotmap = { map, state, perf, geoLog, followPaused, userPaused }; // 動作確認用

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  // 初回は Service Worker が動き始める前に格子ファイルを読み込むため、動き始めたら読み込み済みの分を
  // もう一度要求して端末に保存させる（圏外でもその地域を表示できるように）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    for (const key of tiles.keys()) fetch(`./data/spots/${key}.json`).catch(() => {});
  });
}
