# ロリポップの地図サーバー設定（.htaccess）

このフォルダは、GitHubで共有する設定例と運用資料です。ビューアの公開用フォルダ `docs/` の外に置いています。APIキー・パスワードなどの秘密情報は含めず、実際の認証情報はGit管理外の `.env` で管理します。

ファイルの配置を次のように分けています。

| ファイル | 配信元 |
| --- | --- |
| `static/map/japan.json` | レポっと Archivesと同じサーバー（リポジトリの `docs/static/map/japan.json`） |
| `https://tiles.yukimat.jp/japan.pmtiles` | 現在のロリポップのタイルサーバー |
| `https://tiles.openfreemap.org/planet` | OpenFreeMap（国外・広域用のTileJSON。その中に世界ベクトルタイルのURLを収録） |

ビューアの公開時は `docs/` 配下のスタイルJSONも一緒にアップロードします。`tiles.yukimat.jp/japan.json` は現在のビューアでは使いません。タイルサーバーに必要なのはPMTilesのHTTPS・CORS・Range配信だけです。以前の手順で設置した `.htaccess` は、そのまま利用できます。

ロリポップ用の設定ファイルを [lolipop-tiles.htaccess](lolipop-tiles.htaccess) に用意しています。サーバーの設定ファイルを直接編集する必要はありません。

## 1. 管理画面でHTTPSを有効にする

ロリポップのユーザー専用ページで「証明書お申し込み・設定」を開き、`tiles.yukimat.jp` を選択して「独自SSL（無料）を設定する」を実行します。「SSL保護有効」になった後、`https://tiles.yukimat.jp/japan.pmtiles` をRange要求で取得できることを確認してください（確認コマンドは下記）。

証明書の発行・HTTPSの有効化は `.htaccess` だけでは行えません。`.htaccess` のHTTP→HTTPS転送は、HTTPSが使えるようになってから設定します。[ロリポップ公式：独自SSL（無料）の設定方法](https://lolipop.jp/manual/user/ssl-free-order/)

## 2. .htaccessを設置する

`lolipop-tiles.htaccess` を、`japan.pmtiles` があるサーバー上のフォルダへアップロードし、ファイル名を **`.htaccess`** に変更してください。ビューアを置く `docs/` 相当のフォルダではなく、`tiles.yukimat.jp` のファイル配信フォルダが設置先です。

```text
タイルの公開フォルダ/
├── .htaccess
└── japan.pmtiles
```

既存の `.htaccess` がある場合は、元の内容を保存したうえで設定を追記してください。既存のリライトルールがある場合は、その前に今回のブロックを置きます。ロリポップの公式案内に合わせ、アップロード後のパーミッションは `604` に設定します。[ロリポップ公式：.htaccessの利用方法](https://lolipop.jp/manual/hp/htaccess/)

このファイルは次を設定します。

- `japan.pmtiles` のCORS。公開データのためアクセス元は `*` としています。ひな形は旧構成の `japan.json` にも対応していますが、現在そのファイルはタイルサーバーに置かなくても動作します。
- `206 Partial Content` の応答でも、CORSヘッダーと `Content-Range`・`ETag` などをブラウザから読めるようにする設定。
- 対象2ファイルへのOPTIONS要求に、CORSヘッダー付きの204を返す設定。
- JSON・PMTilesのContent-Type、およびPMTilesのHTTP gzip変換を避ける設定。

ロリポップでは設置前の確認でPMTilesのRange配信が動作していました。`Accept-Ranges: bytes` をヘッダーだけで付ける設定は不要です。PMTilesは必要な部分だけを読み込むため、実際にRange要求へ206を返す必要があります。

## 3. HTTPSへの転送（必要な場合）

HTTPSでPMTilesを取得できることを確認できたら、設定ファイル末尾の次の2行の `#` を外します。

```apache
RewriteCond %{HTTPS} !=on
RewriteRule ^(japan\.(json|pmtiles))$ https://tiles.yukimat.jp/$1 [R=301,L]
```

転送はPMTilesと旧構成の `japan.json` にだけ適用されます。SSL有効化前の転送を避けるため、用意したファイルではコメントアウトしています。

## 4. 応答を確認する

```sh
# PMTiles：206、127バイトの応答、Content-Range、CORSヘッダーを確認
curl -sS -D - -o /dev/null \
  -H 'Origin: https://repot-archive.cocolab.jp' \
  -H 'Range: bytes=0-126' \
  https://tiles.yukimat.jp/japan.pmtiles

# OPTIONS：204とCORSヘッダーを確認
curl -sS -X OPTIONS -D - -o /dev/null \
  -H 'Origin: https://repot-archive.cocolab.jp' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: Range, If-Match' \
  https://tiles.yukimat.jp/japan.pmtiles
```

2つとも `Access-Control-Allow-Origin: *` を返すことを確認します。Range要求では `Content-Range: bytes 0-126/ファイル全体のバイト数` と `Content-Length: 127` を確認します。OPTIONSでは `Access-Control-Allow-Headers` に `Range, If-Match` が含まれている必要があります。キャッシュ機能を有効にしている場合は、設定前の応答が残らないように更新し、上のコマンドで再確認してください。

ビューアの配信先設定は [docs/static/js/map-config.js](../docs/static/js/map-config.js) にあります。スタイルJSONは `import.meta.url` を基準に同じサーバーから読み、PMTilesだけを `tiles.yukimat.jp` から読み込みます。国外・広域はOpenFreeMapから直接読むため、ロリポップに世界地図を追加する必要はありません。地図の色・線・地名の表示を変える場合は、[docs/static/map/japan.json](../docs/static/map/japan.json) を編集してください。タイルサーバーにスタイルJSONをアップロードし直す必要はありません。地図データの帰属表示は保持してください。

## 国外・広域の表示

[OpenFreeMap](https://openfreemap.org/quick_start/) の世界ベクトル地図を、日本と同じスタイルで描画します。APIキー・登録は不要で、追加のサーバー設定もありません。ズーム9以下では世界地図、ズーム10以降では日本のPMTilesを優先し、国外・未収録のタイルを世界地図で補います。日本の配信元が停止している場合も世界地図を利用し、世界地図だけが停止している場合は日本のPMTilesを利用します。

取得処理は [docs/static/js/hybrid-basemap.js](../docs/static/js/hybrid-basemap.js) にあります。両方のデータを1つの地図ソースとして扱うため、地域を移動しても写真マーカーや地図の操作状態は維持されます。配信元・データの帰属表示は `map-config.js` の `worldAttribution` で追加しています。

参考：[Japan PMTiles](https://armd-01.sakura.ne.jp/tiles/)、[PMTilesのMapLibre連携](https://docs.protomaps.com/pmtiles/maplibre)。

## シンプルなスタイル

現在のスタイルは、元データのOpenMapTilesスキーマに合わせ、淡色を基調としつつ、地形・道路・緑地・建物のコントラストを高めた配色と、小さめのグレーの地名ラベルで構成しています。駅名はズーム13以降に小さなグレーの文字で表示します。細かい地名・道路名は拡大時だけに表示し、線路はズーム13から細い淡色線で表示します。道路番号・施設アイコン・枕木模様・立体建物は省いています。

スプライトを使わないため、配布スタイルで発生していた `pedestrian_polygon` の不足警告は解消しています。文字フォントは `https://tile.openstreetmap.jp/fonts/{fontstack}/{range}.pbf` を利用しています。この配信元も自前にする場合は、JSONの `glyphs` を変更してください。
