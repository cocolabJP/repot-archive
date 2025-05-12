import pandas as pd
import json
import subprocess
import urllib.request
import os
import time

js_import = ""
archive_list = ""
archive_meta = {}

# backup_sql = 'v2_backup/backup.sql'

# try:
#   print("download backup.sql from v2 server")
#   remote_url = 'https://repot.sokendo.studio/static/backup/backup_20250430.sql'
#   urllib.request.urlretrieve(remote_url, backup_sql)
# except Exception as e:
#   print("Error download (", backup_sql, ")", e)


all_tsv = 'v2_backup/all.tsv'

try:
  print("download all_repots.tsv from v2 server")
  remote_url = 'https://repot.sokendo.studio/static/archive/all_repots.tsv'
  urllib.request.urlretrieve(remote_url, all_tsv)
except Exception as e:
  print("Error download (", all_tsv, ")", e)

try:
  print("download all photos")
  df_v2 = pd.read_csv(all_tsv, sep='\t')
  for idx, df_row in df_v2.iterrows():
    photo_path = "v2_backup/photo/" + df_row.filename
    if not os.path.isfile(photo_path):
      print("download photo from v2 server: " + df_row.filename)
      remote_url = 'https://repot.sokendo.studio/uploads/original/' + df_row.filename
      urllib.request.urlretrieve(remote_url, photo_path)
except Exception as e:
  print("Error load (", all_tsv, ")", e)
