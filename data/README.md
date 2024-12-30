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