#!/bin/bash

cd ../
sql="SELECT id, name, R.cnt
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
;"
sql=`echo ${sql} | tr -d '\n'`
echo "sql: ${sql}"
docker compose exec -T mysql bash -c "mysql --defaults-extra-file=/tmp/backup/mysql.cnf \$MYSQL_DATABASE -e '${sql}' > /tmp/archive/hashtags.tsv"
echo "done\n"