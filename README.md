# 観光スポットマップ（非公式）

> 本アプリは個人が作成した非公式のもので、OpenStreetMap Foundation・Wikimedia Foundation・Google ほか、いずれの団体・企業とも関係ありません。地点データは OpenStreetMap（© OpenStreetMap contributors、ODbL 1.0）の有志による編集に基づき、正確性・最新性は保証しません（閉館・移転・名称変更が反映されていない場合があります）。営業時間・料金は表示していません。お出かけ前に各施設の公式情報をご確認ください。運転中は操作・注視しないでください。誤りに気づいた場合は OpenStreetMap 本体へ修正いただけると助かります。

公開URL: https://nerorisaia.github.io/drive-guide-app/

（このリポジトリは以前「ドライブガイド」という名前で公衆トイレと観光スポットを扱っていましたが、観光スポットだけを扱う「観光スポットマップ」に作り替えました。公衆トイレの同梱データは削除しています。）

## 機能

- 現在地の周りの **観光スポット** を地図と一覧で表示します（扱うのは観光スポットだけです）。
- 地図は現在地に追従します。地図を手で動かす（ドラッグ・ピンチ・ホイール・ダブルタップ・＋－ボタン）と、手を離した時点から5秒間は追従を止めて表示位置をそのままにし、5秒後に現在地へ戻ります。
- 「現在地」で現在地へ移動し、そのまま追従します（追従の一時停止中でもすぐ戻ります）。
- 「最寄り」で最も近い観光スポット（直線距離。走行中は前方を優先）へ移動してポップアップと説明を開きます。ポップアップを押せるよう10秒間だけ追従を止め、その後は追従に戻ります（途中で「現在地」を押すとすぐ戻ります）。一覧から選んだときも同じです。
- スポットを選ぶと説明文を表示します。「読み上げる」で説明を読み上げます。
- 「Googleマップで案内（車）」で Google マップの経路案内を開きます。
- 広告・課金・利用者データの送信はありません。

## 観光スポットの取得方法

端末から [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)（OpenStreetMap のデータを検索する公開サーバー）へ直接問い合わせます。リポジトリに地点データは同梱していません。

- 取得範囲: 現在地から半径 1km。3件に満たなければ半径 3km まで広げます。全国・広域の一括取得はしません。前回の取得地点から 2km 以上動いたら取り直します。
- 対象タグ:
  - `tourism=attraction`（観光名所）、`tourism=museum`（博物館）、`tourism=gallery`（美術館）、`tourism=zoo`（動物園）、`tourism=aquarium`（水族館）、`tourism=theme_park`（テーマパーク）— 名称（`name`）のあるもののみ
  - `tourism=viewpoint`（展望地）— 名称がなくても表示
  - `historic=castle`（城・城跡）— 名称のあるもののみ
  - いずれも `access=private` / `access=no` は除外
- 公開サーバーが混雑していると、表示まで数十秒かかったり取得に失敗したりします（そのときは「再取得」を押してください）。

## 説明文

OpenStreetMap に `description` があればそれを、無ければ [Wikipedia 日本語版](https://ja.wikipedia.org/) の記事の冒頭を表示します。OpenStreetMap に `wikipedia=ja:…` が登録されていればその記事を、無ければ名称で検索した記事を使います（名称での検索のため、別の記事が表示される場合があります）。どの記事から取ったかを、記事ごとに説明の下へリンク付きで表示します。

## データの出典とライセンス

| データ | 出典 | ライセンス |
|---|---|---|
| 地図画像・観光スポットの地点データ | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| 説明文（Wikipedia の場合） | [Wikipedia 日本語版](https://ja.wikipedia.org/)（記事ごとにアプリ内でリンク） | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja) |

データの誤りは、このリポジトリではなく OpenStreetMap 本体で修正してください。

## コードのライセンス

上記のデータとは別に、本リポジトリのコード部分（`index.html`、`app.js`、`styles.css`、`sw.js`、`manifest.webmanifest`、`tools/` 内のスクリプト、`icons/` のアイコン画像）は MIT License です。全文は [`LICENSE-CODE.txt`](LICENSE-CODE.txt) をご覧ください。MIT License は、上記のデータ（OpenStreetMap・Wikipedia 由来の内容）と同梱ライブラリには適用されません。

同梱ライブラリ: `vendor/leaflet/` の Leaflet 1.9.4 は BSD-2-Clause License（© 2010-2023 Vladimir Agafonkin, © 2010-2011 CloudMade）です。

## オフライン用キャッシュについて

Service Worker のスコープはこのアプリのパス（`/drive-guide-app/`）だけで、キャッシュ名は `spotmap-pages-` で始まる専用の名前です。更新時に消すのは、このアプリ自身の古いキャッシュ（`spotmap-pages-` と、同じURLの旧版「ドライブガイド」の `driveguide-pages-`）だけで、同じドメインで公開している他のアプリのキャッシュには触れません。画面を更新したら `sw.js` の `CACHE` の番号を上げてください。
