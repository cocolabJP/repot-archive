# レポっとのアーカイブ → BODIK ODCS（CSV専用）

クラゲと魚を独立した2つのデータセットで公開します。BODIKへアップロードするファイルはCSVだけです。JSON表や画像ファイルは作成しません。

| 入力ファイル | データセット | CSVリソースID |
| --- | --- | --- |
| `docs/data/archives/komaruKurage.js` | [クラゲ_記録_レポっと](https://data.bodik.jp/dataset/repot-komaru-kurage) | `1c861a5a-2b3d-4252-b973-3a75b35669a5` |
| `docs/data/archives/chushikokuSakana.js` | [魚情報_記録_レポっと](https://data.bodik.jp/dataset/repot-chushikoku-sakana) | `58db4a32-57e4-4416-b648-91f0c1bea5b2` |

`image_url` は `https://data.cocolab.jp/repot/<元の画像ファイル名>` です。サムネイルを利用する場合の配信先は `https://data.cocolab.jp/repot-thumb/<元の画像ファイル名>` です。CSVには元画像のURLを収録します。

## 実行方法

追加パッケージは不要です。Node.js 18.17以降に対応し、下記の `--env-file` の例はNode.js 20.6以降を使います。コマンドはリポジトリのルートから実行してください。

```sh
# 初回のみ。APIトークンを.envに設定する
cp -n data/_bodik_odcs/.env.example data/_bodik_odcs/.env
# 外部通信なしでCSVを生成
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --dry-run
# CSVだけをアップロード
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --send
# 対象を絞る
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --target komaruKurage --send
```

通常実行も `--dry-run` と同じです。CSVは `output/komaruKurage.csv`、`output/chushikokuSakana.csv` に生成し、`--csv-dir /path/to/output` で保存先を変更できます。`--output /path/to/plan.json` はローカル確認用の実行計画を保存するだけで、JSONをBODIKへアップロードしません。既存の計画ファイルは上書きしません。

従来の `--upload-csv` は互換用として受け付けます。画像・JSON送信用の `--upload-images`、`--insert-only`、`--force` は通信前にエラーにします。ローカルの画像ファイルがなくてもCSVを生成・送信できます。

## CSVの項目

列順は次の9項目です。DataStoreが自動付与する `_id` はCSVに含めません。

```text
id,timestamp,lat,lon,caption,image_url,created_at,updated_at,deleted_at
```

| 項目 | 変換元・扱い |
| --- | --- |
| `id` | 従来どおり `repot:` + `slug` のSHA-256先頭32 bitから `1000000000 + (値 % 1147483648)` で生成。同じ投稿のIDを維持 |
| `timestamp` | 元のUTC epoch秒 |
| `lat`, `lon` | 元の `location_lat`, `location_lng` |
| `caption` | 元のコメント。`null` は空文字 |
| `image_url` | `https://data.cocolab.jp/repot/` + URLエンコードした元の画像ファイル名 |
| `created_at`, `updated_at` | 元データに専用日時がないため、`timestamp` のUTC ISO 8601表記 |
| `deleted_at` | `null` |

旧項目の `user_id`, `slug`, `location_alt`, `status`, `tags`, `species`, `filename`, `source` はCSVに含めません。`slug` と元の画像ファイル名はID生成・画像URL生成のために内部で使用します。公開アーカイブの元データは変更しません。

座標欠損または `-1, -1` の投稿を除外し、不正な日時・座標はエラーにします。現在の対象はクラゲ9件、魚10件（11件中、座標欠損1件を除外）です。毎回ローカルの対象アーカイブ全件からCSVを作り、そのCSV全体で既存ファイルを差し替えます。

CSVはUTF-8（BOM付き）、行区切りはCRLFです。コメントのカンマ・引用符・改行をエスケープします。`null` と空文字はどちらも空欄になります。

## 送信と既存リソースの整理

送信前に両分類のデータセット・組織・管理情報とCSVリソースIDを検証します。既存CSVはバックアップしてから同じリソースIDで更新し、ダウンロードしたファイルと生成CSVのSHA-256が一致することを確認します。内容が同じCSVは再利用します。データセットの説明・出典・タグもCSV専用構成に合わせます。

通常の `--send` ではリソースを削除しません。旧構成からの移行には次を使います。

```sh
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --send --replace-legacy
```

`--replace-legacy` は、両CSVの取得検証を終えた後、対象データセットの管理対象JSON表・画像を削除します。削除前にJSONの全行、画像ファイル、旧CSV、リソース情報を `output/backups/csv_only_<UUID>/` に保存します。JSONの投稿がCSVに含まれない場合、画像のハッシュ不一致、確認後の内容変更などを検出すると停止します。管理対象外のリソースは削除しません。送信・削除の途中経過は `output/csv_upload_report.json` とバックアップ内の `result.json` に保存します。

CSVのアップロード・2分類の処理・削除は単一のトランザクションではありません。途中失敗時はレポートで実施済みの処理を確認してください。自動再試行は行いません。CSVのダウンロードファイルが公開データの本体です。BODIKがCSVをDataStoreに自動取り込みした場合も、独立したJSONリソースをこのスクリプトから追加することはありません。

## 設定とフォルダ

送信先と公開用説明は `config/datasets.json` に保存します。`csv_resource_id` が現在のCSV送信先で、`legacy_table_resource_id` は旧JSONを削除するときの識別用です。新しいデータセットではCSVの初回作成後に、レポートのIDを `csv_resource_id` に保存してください。APIトークンをこのファイルに保存しないでください。

| 環境変数 | 設定内容 |
| --- | --- |
| `CKAN_API_KEY` | APIトークン |
| `CKAN_BASE_URL` | 既定値 `https://data.bodik.jp` |
| `CKAN_PACKAGE_ID_KOMARU_KURAGE` / `CKAN_PACKAGE_ID_CHUSHIKOKU_SAKANA` | 分類別データセットID |
| `CKAN_CSV_RESOURCE_ID_KOMARU_KURAGE` / `CKAN_CSV_RESOURCE_ID_CHUSHIKOKU_SAKANA` | 分類別CSVリソースID |
| `ODCS_IMAGE_BASE_URL` | 元画像の配信先。既定値 `https://data.cocolab.jp/repot/` |

```text
_bodik_odcs/
├── upload_to_odcs.js    # CSV専用アップローダー
├── setup_datasets.js    # データセットだけを初期作成（JSON表は作らない）
├── update_metadata.js   # CSV公開処理への互換用入口
├── config/              # 送信先・公開用説明
├── lib/                 # 変換・CSV公開・旧リソース識別処理
├── tests/               # 外部通信しないテスト
├── output/              # CSV・計画・移行バックアップ（Git管理対象外）
├── reports/             # 検証記録
├── .env                 # APIトークン（Git管理対象外）
└── .env.example         # 秘密情報を含まない設定例
```

`setup_datasets.js --send` は管理対象の2データセットを作成・確認します。JSON表・画像は作りません。`update_metadata.js` は `upload_to_odcs.js` と同じCSV公開処理を実行します。

## 過去の記録・テスト

2026年11月20日に、クラゲ9件・魚10件のCSVを9列と外部画像URLに差し替え、旧JSON表2件と画像38枚（過去試験分19枚を含む）を削除しました。CSVリソースIDとダウンロードURLは維持しています。元のダミーCSV2件と126レコードは変更していません。[CSV専用構成への移行記録](reports/csv_only_migration_20261120.json)

BODIKの標準CSV自動取り込みAPIは、この環境では無効でした。旧17列・旧画像URLが残っていたプレビュー用DataStore表もバックアップ後に削除し、CSV本体を公開しています。プレビューやDataStore APIによる参照を使うには、BODIK側でCSVの自動取り込み設定が必要です。このスクリプトはJSONによるDataStoreへの直接登録を行いません。

2026年11月19日の旧17項目のJSON・画像・CSVの登録記録は、履歴として維持しています。

- [分類別の旧登録検証](reports/upload_verification_separated_20261119.json)
- [旧CSVの検証](reports/csv_verification_20261119.json)
- [ダミーデータセットでの先行試験](reports/upload_verification_20261119.json)

```sh
node --test data/_bodik_odcs/tests/*.test.js
```
