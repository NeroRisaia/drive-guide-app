# ドライブガイド（観光ガイド付きカーナビ・非公式）

> 本アプリは個人が作成した非公式の案内です。OpenStreetMap Foundation・Wikimedia Foundation・Google ほか、いずれの団体・企業とも関係ありません。地点データは OpenStreetMap の有志による編集に基づき、正確性・最新性は保証しません（閉鎖・移転・名称変更が反映されていない場合があります）。運転中は操作・注視せず、現地の表示・交通ルールに従ってください。

公開URL: https://nerorisaia.github.io/drive-guide-app/

## できること

- 現在地の周りの **公衆トイレ** と **観光スポット** を地図と一覧で表示します。
- 「最寄りトイレへ案内」とカードの「Googleマップで案内」で、Google マップの経路案内（車）を開きます。
- 観光スポットを選ぶと説明文を表示・読み上げます（ミュート可）。近づくと名前を読み上げます。
- 地図は現在地に追従します。地図を手で動かす（ドラッグ・ピンチ・ホイール・ダブルタップ・＋－ボタン）と、手を離した時点から5秒間はその表示位置のままにし、5秒たったら現在地へ戻ります。
- 一度開くとアプリ本体と全国の公衆トイレデータが端末に保存され、圏外でも最寄りのトイレを探せます（地図画像と観光スポットは通信が必要です）。
- 広告・課金・利用者データの送信はありません。

## データの取得方法

- **観光スポット**: 端末から [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)（OpenStreetMap のデータを検索する公開サーバー）へ直接問い合わせます。取得範囲は現在地（＝追従中の地図の中心）から半径 1km、足りなければ 3km までです。全国・広域の一括取得はしません。公開サーバーが混雑していると、表示まで数十秒かかったり取得に失敗したりします（そのときは「再取得」を押してください）。
- **公衆トイレ**: 同梱の [`data/toilets-jp.json`](data/toilets-jp.json)（全国 32,225 件）を端末内で検索します。
- **説明文**: [Wikipedia 日本語版](https://ja.wikipedia.org/) の API から取得します（OpenStreetMap に description がある地点はそれを使います）。どの記事から取ったかを説明の下に表示します。名称での検索のため、別の記事が表示される場合があります。
- **地図画像**: OpenStreetMap のタイル（tile.openstreetmap.org）。

## データの出典とライセンス

| データ | 出典 | ライセンス |
|---|---|---|
| 地図画像・観光スポット・公衆トイレ | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| 説明文 | [Wikipedia 日本語版](https://ja.wikipedia.org/)（記事ごとにアプリ内でリンク） | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja) |

`data/toilets-jp.json` は OpenStreetMap から抽出した派生データベース（`amenity=toilets` のうち `access=private` / `access=no` を除いたもの。緯度・経度×10^5 と名称）であり、Open Database License (ODbL) 1.0 で提供されます（https://opendatacommons.org/licenses/odbl/1-0/）。データ作成日：2026年11月7日（Geofabrik が配布する OpenStreetMap 日本データから `tools/build_toilets.py` で作成）。

データの誤りは、このリポジトリではなく OpenStreetMap 本体で修正してください。

## コードのライセンス

上記のデータとは別に、本リポジトリのコード部分（`index.html`、`app.js`、`styles.css`、`sw.js`、`manifest.webmanifest`、`tools/` 内のスクリプト、`icons/` のアイコン画像）は MIT License です。全文は [`LICENSE-CODE.txt`](LICENSE-CODE.txt) をご覧ください。MIT License はデータ（`data/`）と同梱ライブラリには適用されません。

同梱ライブラリ: `vendor/leaflet/` の Leaflet 1.9.4 は BSD-2-Clause License（© 2010-2023 Vladimir Agafonkin, © 2010-2011 CloudMade）です。

## オフライン用キャッシュについて

Service Worker のスコープはこのアプリのパス（`/drive-guide-app/`）だけで、キャッシュ名は `driveguide-pages-` で始まる専用の名前です。更新時に消すのも自分の古いキャッシュだけで、同じドメインで公開している他のアプリのキャッシュには触れません。

## 公衆トイレデータの作り直し

```
pip install osmium
curl -L -o japan-latest.osm.pbf https://download.geofabrik.de/asia/japan-latest.osm.pbf
python tools/build_toilets.py japan-latest.osm.pbf data/toilets-jp.json
```

作り直したら `sw.js` の `CACHE` の番号を上げてください。
