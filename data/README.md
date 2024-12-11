# repot-v2サーバでハッシュタグID別エクスポートを行うためのクエリ

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
        hashtags.name separator ';'
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
