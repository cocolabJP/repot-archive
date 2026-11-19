# 写真・サムネイルの FTP アップロード

`2_upload_photos_ftp.py` は、WebDAV を使う `2_upload_photos.sh` と同じ写真・サムネイルを FTP / FTPS でアップロードします。Python 3 の標準ライブラリだけで動きます。以下はリポジトリのルートから実行する例です。入力フォルダはスクリプトの位置から解決するため、別の場所から起動しても使えます。

| ローカル | FTP 上の送信先（既定値） |
| --- | --- |
| `data/archive_photo/` | `/repot-archive/photo/` |
| `data/archive_thumb/` | `/repot-archive/thumb/` |

## 接続せず対象を確認する

元のシェルスクリプトと同じ、2026年10月の画像を対象にする例です。通常実行も `--dry-run` と同じ動作で、FTP サーバーへ接続しません。

```sh
python3 data/2_upload_photos_ftp.py --pattern '202610*.png' --dry-run
```

`--pattern` を省略すると `20*.png`（全期間）が対象です。複数月なら `--pattern '202610*.png' --pattern '202611*.png'` のように指定できます。表示は各フォルダ先頭10件までで、`--verbose` を付けると全件表示します。

## 接続情報を設定する

接続情報はリポジトリ直下の `.env` にまとめます。スクリプトが自動で読み込むため、毎回環境変数を設定したり、`--config` を付けたりする必要はありません。実行ディレクトリに依存せず、スクリプトの位置から探します。

ひな形はルートの [.env.example](../.env.example) です。新しく設定する場合はこれを `.env` にコピーし、`FTP_HOST` / `FTP_USER` / `FTP_PASSWORD` を入力します。既に `.env` がある場合はそのファイルを編集してください。送信先フォルダや接続方式も同じファイルで設定します。

従来の `FTP_SERVER` / `FTPS_SERVER` / `FTP_ACCOUNT` / `FTP_PASS` などの別名にも対応しています。`FTP_HOST` がある場合はそれを優先し、ない場合はFTPS接続なら `FTPS_SERVER`、通常のFTP接続なら `FTP_SERVER` を選びます。WebDAV用の情報は使いません。

`KEY=VALUE` 形式は引用符、`export`、行末コメントに対応します。`#` を含むパスワードは引用符で囲めます。コロン形式の値は、`#` や引用符も含めて文字列として読みます。シェルコマンドの実行や変数展開は行いません。

ロリポップの場合は、ユーザー専用ページ「アカウント情報／パスワード変更」の **FTPSサーバー名**、**FTP・WebDAVアカウント**、**FTP・WebDAVパスワード** を使います。既定は明示的 FTPS・ポート21・パッシブモードです。[ロリポップ公式の設定案内](https://lolipop.jp/manual/hp/ftp-set/)

パスワードが未設定の場合、`--send` 時にターミナルで非表示入力できます。自動実行など対話入力ができない場合は、`.env`、環境変数または設定ファイルに指定してください。アカウント名・パスワードは通常ログやdry-runの表示には出しません。

| `.env` / 環境変数の項目 | 用途 | 既定値 |
| --- | --- | --- |
| `FTP_HOST` | サーバー名 | 未設定 |
| `FTP_USER` | アカウント名 | 未設定 |
| `FTP_PASSWORD` | パスワード | 未設定 |
| `FTP_REMOTE_DIR` | 送信先の親ディレクトリ | `/repot-archive` |
| `FTP_PROTOCOL` | 接続方式 | `ftps` |
| `FTP_PORT` | ポート番号 | `21` |
| `FTP_TIMEOUT` | タイムアウト | `60` 秒 |

通常のFTP接続には `.env` に `FTP_PROTOCOL=ftp` を指定します。FTPSから通常のFTPへ自動的に切り替えることはありません。通常はルートの `.env` だけを編集します。互換性のため `data/.env` と `data/ftp_upload.ini` にも対応しており、これらがある場合の優先順位は、実行環境の環境変数、`data/.env`、リポジトリ直下の `.env`、`data/ftp_upload.ini`、既定値の順です。

別の `.env` を使う場合は `--env-file /path/to/ftp.env` で指定します。この場合、自動検出する `.env` やINIは混ぜません。従来のINI形式も使えます。[ftp_upload.example.ini](ftp_upload.example.ini) を `ftp_upload.ini` にコピーして設定してください。`--config /path/to/ftp_upload.ini` を明示した場合も、自動検出する `.env` は読みません。両形式を意図的に組み合わせる場合は、`--config` と `--env-file` を両方指定します（`.env` が優先）。環境変数は常に最優先です。

`.env` と `data/ftp_upload.ini` は Git 管理対象外です。ひな形には認証情報を書き込まないでください。

## 実際に送信する

```sh
python3 data/2_upload_photos_ftp.py --pattern '202610*.png' --send
```

送信先の一覧に同名がある画像は、元の `cp -n` と同じようにスキップします。未登録画像は一時名で転送し、サイズを確認してから元の名前に変更します（サーバーが `SIZE` 非対応の場合は、FTP の転送完了応答で確認します）。途中で失敗した画像は元の名前に変更せず、その実行の一時ファイルを可能な範囲で削除して停止します。再実行すると、送信済みの画像はスキップされます。

`remote_dir` は FTP ログイン時のルートに合わせて調整してください。この親ディレクトリは既に存在する必要があります。配下の `photo` / `thumb` がなければ作成します。FTPS の証明書を検証し、認証・画像転送の両方を暗号化します。

FTP では画像ファイルの中身だけを送るため、macOS の `._` ファイルは送りません。既存の画像や `._` ファイルを一括削除する処理はありません。同じ送信先への並行実行は避けてください。接続断の状況によっては `.repot-upload-*.tmp` が残る場合があります。

ローカルテスト（実サーバーには接続しません）:

```sh
python3 -m unittest discover -s data/tests -p 'test_upload_photos_ftp.py' -v
```

# repot-v2サーバでレポっとデータをハッシュタグID別にエクスポートするクエリ

```
SELECT
  timestamp, slug, filename, caption, location_lat, location_lng, location_alt, location_acc,  H.hashtag_names
FROM
  repots
INNER JOIN
  (
    SELECT
      repot_id,
      group_concat(
        distinct
        hashtags.name separator ";"
      ) AS hashtag_names
    FROM
      repot_hashtag_relationships AS R
    INNER JOIN
      hashtags ON R.hashtag_id = hashtags.id
    GROUP BY
      repot_id
  ) AS H ON repots.id = H.repot_id
WHERE
  id in (
    SELECT repot_id FROM repot_hashtag_relationships WHERE hashtag_id = 5
  )
;
```

CSVに出力

```
docker compose exec mysql bash -c "mysql --defaults-extra-file=/tmp/backup/mysql.cnf $MYSQL_DATABASE -e "SELECT
timestamp, slug, filename, caption, location_lat, location_lng, location_alt, location_acc, H.hashtag_names
FROM
  repots
INNER JOIN (
  SELECT
    repot_id,
    group_concat(
      distinct
      hashtags.name separator \";\"
    ) AS hashtag_names
    FROM
      (SELECT hashtag_id, repot_id FROM repot_hashtag_relationships WHERE is_active = 1) AS R
    INNER JOIN
      hashtags ON R.hashtag_id = hashtags.id
    GROUP BY
      repot_id
  ) AS H ON repots.id = H.repot_id
WHERE
  id in (
    SELECT repot_id FROM repot_hashtag_relationships WHERE is_active = 1 AND hashtag_id = 3
  )
;" > /tmp/archive/3.tsv'
```


# repot-v2サーバでハッシュタグリストをエクスポートするクエリ


```
SELECT id, name, R.cnt
FROM
  hashtags
LEFT OUTER JOIN
  (
    SELECT
      hashtag_id,
      count(*) AS cnt
    FROM
      repot_hashtag_relationships
    GROUP BY
      hashtag_id
  ) AS R ON id = R.hashtag_id
ORDER BY R.cnt DESC
;
```
