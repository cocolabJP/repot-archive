# レポっとのアーカイブ → BODIK ODCS

魚とクラゲを**独立した2つのデータセット**に登録します。それぞれに専用の投稿表と画像ファイルを置きます。Node.js 18.17 以降を使い、追加パッケージは不要です。`.env` を `--env-file` で読み込む例は Node.js 20.6 以降が対象です。

| 入力ファイル | データセット | 投稿表リソース ID |
| --- | --- | --- |
| `docs/data/archives/komaruKurage.js` | [クラゲ_記録_レポっと](https://data.bodik.jp/dataset/repot-komaru-kurage) | `debd70f2-4bef-471a-af13-4ca801bc7cba` |
| `docs/data/archives/chushikokuSakana.js` | [魚情報_記録_レポっと](https://data.bodik.jp/dataset/repot-chushikoku-sakana) | `2133dba3-2074-41ef-b11d-10f4f47d24ce` |

送信先は [config/datasets.json](config/datasets.json) に保存しています。同じデータセットや同じ投稿表を両分類に指定すると停止します。送信時には、投稿表が設定したデータセットに所属することも確認します。

## フォルダ構成

```text
_bodik_odcs/
├── upload_to_odcs.js       # 投稿・画像・CSVのアップロード
├── setup_datasets.js       # データセットと投稿表の初期作成
├── update_metadata.js      # 公開用の名称・説明文の更新
├── lib/                    # 画像・CSV・メタデータの共通処理
├── config/
│   └── datasets.json       # 分類別の送信先と公開用設定
├── tests/                  # 外部通信しないローカルテスト
├── output/                 # 生成CSV・プレビュー・CSV送信レポート（Git管理対象外）
├── reports/                # アップロードの検証記録・メタデータ更新レポート
│   └── backups/            # メタデータ更新前のバックアップ
├── .env                    # APIトークン（Git管理対象外）
└── .env.example            # 認証情報のひな形
```

実行用スクリプトは直下にあり、以降のコマンドはリポジトリのルートから実行します。検証記録やバックアップの保存先はスクリプトの位置から解決します。

## 認証情報

APIトークンは Git 管理対象外の `.env` に保存します。`.env.example` は秘密情報を含まないひな形です。既に `.env` がある場合はその設定を使ってください。

```sh
cp -n data/_bodik_odcs/.env.example data/_bodik_odcs/.env
# .env の CKAN_API_KEY に APIトークンを設定する
```

以降はリポジトリのルートから実行する例です。入力ファイルはスクリプトの位置から解決します。Node.js 18 系では `--env-file` を使わず、環境変数を設定して実行してください。

## 送信しない確認

**通常実行と `--dry-run` は外部通信しません。** 表データを分類ごとに変換し、画像の存在・先頭シグネチャ・容量・SHA-256 をローカルで確認します。

```sh
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --upload-images --dry-run
```

確認用JSONを保存する場合（既存ファイルは上書きしません）:

```sh
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --upload-images --dry-run --output /tmp/repot_odcs_plan.json
```

出力は `datasets` 配列で分類ごとに分かれています。各要素は `target`、`dataset_id`、`payload`、画像を扱う場合は `images` を持ちます。画像URLは送信時に確定するため、画像送信計画内の `image_url` は `null` です。確認用JSON全体を `datastore_upsert` に直接送らないでください。

## 実際に送信する

```sh
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --upload-images --send
```

クラゲだけ・魚だけに絞る場合:

```sh
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --target komaruKurage --upload-images --send
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --target chushikokuSakana --upload-images --send
```

`--upload-images` を省略すると、既存の公開アーカイブの写真URLを使って表データだけを送ります。

## CSVも生成・アップロードする

`--upload-csv` を追加すると、JSON投稿表の更新後に全件を読み直し、同じ17列を持つCSVを生成して、その分類のデータセットに追加します。写真URLも更新後の投稿表と同じ値になります。今回送信する投稿以外に、過去に登録した行が残っている場合もCSVに含めます。

```sh
# 接続せず、JSONの送信計画とCSVプレビューを生成
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --upload-images --upload-csv --dry-run
# JSON投稿表・画像・CSVを送信
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/upload_to_odcs.js --upload-images --upload-csv --send
```

CSVは既定で `data/_bodik_odcs/output/` に保存します。このフォルダはGit管理対象外です。出力先は `--csv-dir /path/to/output` で変更できます。

| ファイル | 内容 |
| --- | --- |
| `komaruKurage.preview.csv` / `chushikokuSakana.preview.csv` | ローカルの送信予定レコード。画像送信を伴う場合、未確定の写真URLは空欄 |
| `komaruKurage.csv` / `chushikokuSakana.csv` | 送信後のJSON投稿表から生成する確定CSV |
| `csv_upload_report.json` | CSVリソースID、ダウンロードURL、件数、SHA-256、取得検証の結果 |

`--dry-run` ではプレビューだけを生成し、BODIKには接続しません。`--send` 時には確定CSVを原子的に保存し、同じ名前の生成ファイルを更新します。CSVの文字コードは **UTF-8（BOM付き）**、行区切りは **CRLF** です。コメント中の半角カンマ・引用符・改行をCSVとしてエスケープします。`null` と空文字はどちらも空欄に出力し、数値・UTC日時・日本語の元の値を保持します。

公開用の表示名は「投稿データ_CSV」とし、既存のAPI投稿表とは別のファイルリソースに保存します。再送時は管理情報で同じCSVを特定し、内容が同じなら再利用、変わっていれば同じリソースIDを維持して更新します。同名の管理対象外CSVは上書きしません。アップロード後にCSVを取得し直し、生成ファイルとのSHA-256一致を確認します。

送信処理は次の順です。

1. 両分類のローカルデータと送信先を確認する。どちらかに不備があれば、画像・投稿データの登録前に停止する。
2. 投稿表の列、一意キー、null制約、既存ID・slugの衝突を確認する。
3. 対応画像を、その分類のデータセット内に `resource_create` で保存する。表示名は `投稿写真_<ファイル名>` とし、説明文には出典・利用条件を掲載する。説明欄のHTMLコメントに保持したファイル名・SHA-256で既存画像を確認し、同じ内容なら再利用、変更がある場合だけ `resource_patch` で更新する。旧表示名 `repot-image:<ファイル名>` と旧管理形式も認識する。
4. APIが返した画像URLをその分類の `image_url` に設定する。
5. 既存行の衝突を再確認し、分類ごとの `datastore_upsert`（`method: upsert`）で投稿を登録・更新する。
6. `--upload-csv` 指定時は、JSON投稿表を全件取得してCSVを生成・保存し、同じデータセットのCSVファイルを登録・更新する。

新しい投稿表は `datastore_create` で作ったAPI更新用リソースです。`id` の一意キーを作成しており、通常の送信に `--force` は不要です。BODIKの列情報が一意インデックスを `uniquekey:false` と返す場合は、公式の `dry_run:true` を使って更新APIが受理されることと検証行が残らないことを確認します。この検証は `--send` 時のみ行い、`--dry-run` では接続しません。[CKAN公式ドキュメント](https://docs.ckan.org/en/2.11/maintaining/datastore.html)

画像の保存と投稿表の更新、2分類の送信は、単一のトランザクションにはなりません。途中で失敗した場合、成功済みの画像・投稿は残ります。再実行時は既存画像を再利用し、同じ投稿IDを更新します。自動再試行・自動削除は行いません。同じ送信先への同時実行は避けてください。

## 項目変換

| ODCS項目 | 変換元・扱い |
| --- | --- |
| `id` | `repot:` + `slug` のSHA-256先頭32 bitから `1000000000 + (値 % 1147483648)` で生成。分類や並び順に依存しない |
| `user_id` | 元データにないため `null` |
| `slug`, `timestamp` | 元の値を保持。`timestamp` はUTC epoch秒 |
| `lat`, `lon` | `location_lat`, `location_lng` |
| `location_alt` | 元の高度を文字列化。欠損は空文字 |
| `status` | 添付サンプルと同じ既定値 `confirmed`。独自の生物種同定は行わない |
| `caption` | 元の値。`null` は空文字 |
| `tags` | 元のタグに分類タグを補い、半角 `#` 付きの空白区切り文字列にする |
| `species` | 専用項目がないため空文字。説明文からは推定しない |
| `filename` | 元の画像ファイル名 |
| `image_url` | 画像送信時はBODIKが返したURL。表だけ送る場合は公開アーカイブURL |
| `source` | `repot` |
| `created_at`, `updated_at` | 元データに専用日時がないため、両方に `timestamp` のUTC ISO 8601表記を使用 |
| `deleted_at` | `null`。元データから消えた投稿を自動削除する処理はない |

クラゲには `#困クラゲ #クラゲ`、魚には `#中四国魚 #魚` を補います。`caution_flag: true` は `#利用上の注意` として復元します。`location_acc` は送信しません。

座標欠損または `-1, -1` の投稿は、slugと理由を表示して除外します。不正な日時や範囲外の座標は全体をエラーにします。2026年11月19日の対象は、クラゲ9件、魚10件（11件中、座標欠損1件を除外）です。画像は `data/archive_photo` から読み、PNG / JPEG / GIF / WebP に対応します。縮小・変換は行いません。

## 送信先設定の上書き

| 環境変数 | 設定内容 |
| --- | --- |
| `CKAN_API_KEY` | APIトークン |
| `CKAN_BASE_URL` | 既定値 `https://data.bodik.jp` |
| `CKAN_RESOURCE_ID_KOMARU_KURAGE` | クラゲ用投稿表ID。省略時は `config/datasets.json` |
| `CKAN_PACKAGE_ID_KOMARU_KURAGE` | クラゲ用データセットID。省略時は `config/datasets.json` |
| `CKAN_RESOURCE_ID_CHUSHIKOKU_SAKANA` | 魚用投稿表ID。省略時は `config/datasets.json` |
| `CKAN_PACKAGE_ID_CHUSHIKOKU_SAKANA` | 魚用データセットID。省略時は `config/datasets.json` |
| `ODCS_IMAGE_DIR` | ローカル画像ディレクトリ。既定値はスクリプトから見た `../archive_photo` |
| `ODCS_IMAGE_BASE_URL` | 画像を送らない場合の配信先。既定値 `https://repot-archive.yukimat.jp/photo/` |

1つの送信先を両分類で共有する設定は使いません。送信先を上書きする場合は、分類別の投稿表IDとデータセットIDを対で指定してください。

## 初期データセット・投稿表の作成

`setup_datasets.js` は、`config/datasets.json` に定義した組織・ライセンスで独立した2データセットと投稿表を作ります。既に作成済みなら管理情報を確認して再利用します。同名の管理対象外データセットは変更しません。APIトークンを `config/datasets.json` に保存しないでください。

```sh
# 接続せず作成予定を表示
node data/_bodik_odcs/setup_datasets.js --dry-run
# 実際に作成・確認
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/setup_datasets.js --send
```

一意キーの指定は新しく作る投稿表にだけ適用します。既存CSVのスキーマ変更や読み取り専用制限の上書きは行いません。

## 公開用の名称・説明文を更新する

`config/datasets.json` の `title`、`description`、`source_url`、`tags`、`resource_name`、`resource_description` が公開用メタデータの元になります。cscacの他事例と同じく、試行中の表示、出典、加工内容、収録項目、利用条件を記載しています。言語は `Japanese`、クレジットは出典に合わせた `© repot contributors (modified)` としています。

```sh
# 接続せず変更予定を確認
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/update_metadata.js --dry-run --output /tmp/repot_metadata_plan.json
# 更新前にバックアップを保存してから反映
node --env-file=data/_bodik_odcs/.env data/_bodik_odcs/update_metadata.js --send
```

データセットの名称・説明・出典・タグ・追加情報と、投稿表・写真の表示名・説明だけを更新します。データセットURL、リソースID、写真URL、投稿表の内容を維持し、更新前後で確認します。更新前の記載を `reports/backups/metadata_backup_*.json` に、更新結果を [reports/metadata_update_report.json](reports/metadata_update_report.json) に保存します。保存先のフォルダがなければ作成します。バックアップの保存先は `--backup /path/to/backup.json` で変更できます。同じ内容なら再更新はしません。

内部の管理用情報は説明欄のHTMLコメントに保持し、公開画面には表示しません。この形式は投稿スクリプトと初期作成スクリプトでも扱うため、説明文の更新後も画像の再利用や投稿表の再確認ができます。

## 検証・過去の試験記録

2026年11月19日に、クラゲ用へ9件・画像9枚、魚用へ10件・画像10枚を実際に登録しました。表の全項目、画像URLの所属、公開URLから取得した画像のSHA-256を全件確認しています。`force` は使用していません。結果は [分類別の検証記録](reports/upload_verification_separated_20261119.json) に保存しています。

同日にCSVもクラゲ9件・魚10件をそれぞれ追加しました。アップロード後のハッシュ一致に加え、CSV標準パーサーで17列・全行を読み直し、JSON投稿表との全項目一致を確認しています。ダウンロードURLと検証結果は [CSV検証記録](reports/csv_verification_20261119.json) に保存しています。

```sh
node --test data/_bodik_odcs/tests/*.test.js
```

ローカルテストは外部に接続せず、分類別の表・画像・送信先の分離、誤送信時の停止、変換、重複検査、画像の再利用、途中失敗後の再実行、データセット作成を検証します。

先行試験では、共通の[ダミーデータセット](https://data.bodik.jp/dataset/cscac_modelcase04)に画像19枚だけを登録しました。投稿データの追加は読み取り専用制限で拒否され、既存126件は変更していません。先行試験の画像は削除せず残しています。当時の記録は [upload_verification_20261119.json](reports/upload_verification_20261119.json) です。

添付の `③_Jellyfish.html` は現在、ポップアップに緯度・経度だけを表示します。画像を画面に表示するには、別途 `image_url` を使う表示処理が必要です。
