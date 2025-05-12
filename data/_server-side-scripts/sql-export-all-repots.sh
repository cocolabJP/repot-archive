#!/bin/bash

cd ../
echo -e "\n\n -------- start backup --------\n\n"
echo "export archive data"
sql="SELECT
       timestamp, slug, filename, caption, location_lat, location_lng, location_alt, location_acc
     FROM
       repots
     WHERE deleted_at IS NULL
;"
sql=`echo ${sql} | tr -d '\n'`
echo "sql: ${sql}"
docker compose exec -T mysql bash -c "mysql --defaults-extra-file=/tmp/backup/mysql.cnf \$MYSQL_DATABASE -e '${sql}' > /tmp/archive/all_repots.tsv"
echo -e "done\n"

echo "export database (mysqldump)"
docker compose exec -T mysql bash -c "mysqldump --defaults-extra-file=/tmp/backup/mysql.cnf \$MYSQL_DATABASE > /tmp/backup/backup/backup_`date +%Y%m%d`.sql"
echo -e "done\n"
