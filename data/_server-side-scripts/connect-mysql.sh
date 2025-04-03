#!/bin/bash

cd ../
docker compose exec -it mysql bash -c "mysql --defaults-extra-file=/tmp/backup/mysql.cnf \$MYSQL_DATABASE"