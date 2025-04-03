#!/bin/bash

cd ../
target=$1
echo "target: ${target}"
sql="SELECT
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
         SELECT repot_id FROM repot_hashtag_relationships WHERE is_active = 1 AND hashtag_id = ${target}
       ) AND
       deleted_at IS NULL
;"
sql=`echo ${sql} | tr -d '\n'`
echo "sql: ${sql}"
docker compose exec -T mysql bash -c "mysql --defaults-extra-file=/tmp/backup/mysql.cnf \$MYSQL_DATABASE -e '${sql}' > /tmp/archive/${target}.tsv"
echo "done\n"