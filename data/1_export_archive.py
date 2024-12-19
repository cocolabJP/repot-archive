import pandas as pd
import json
import subprocess
import urllib.request
import os

### v1 データ（変換済み）と v2 データを統合した、アーカイブ生成コード

df_hashtags = pd.read_csv("archive_list.csv")
print(df_hashtags)

subprocess.call("rm ../docs/data/archives/*.js", shell=True)
subprocess.call("rm archive_photo/*.png", shell=True)

js_import = ""
archive_list = ""
archive_meta = {}

for row in df_hashtags.itertuples():
  print("\n[", row.slug, "]")
  # ------------ v1
  df_v1 = None
  if row.v1 != -1:
    target_tsv = 'v1_tsv/' + str(row.v1) + '.tsv'
    print("load: " + target_tsv)
    try:
      df_v1 = pd.read_csv(target_tsv, sep='\t')
      for idx, df_row in df_v1.iterrows():
        subprocess.call(["cp", "v1_photo/" + df_row.filename, "archive_photo/"])
    except Exception as e:
      print("Error (", target_tsv, ")", e)

  # ------------ v2
  df_v2 = None
  if row.v2 != -1:
    target_tsv = 'v2_tsv/' + str(row.v2) + '.tsv'

    try:
      print("download csv from v2 server: " + target_tsv)
      remote_url = 'https://repot.sokendo.studio/static/db-exports/' + str(row.v2) + '.tsv'
      urllib.request.urlretrieve(remote_url, target_tsv)
    except Exception as e:
      print("Error download (", target_tsv, ")", e)

    try:
      print("load: " + target_tsv)
      df_v2 = pd.read_csv(target_tsv, sep='\t')
      for idx, df_row in df_v2.iterrows():
        photo_path = "v2_photo/" + df_row.filename
        if not os.path.isfile(photo_path):
          print("download photo from v2 server: " + df_row.filename)
          remote_url = 'https://repot.sokendo.studio/uploads/original/' + df_row.filename
          urllib.request.urlretrieve(remote_url, photo_path)
        subprocess.call(["cp", photo_path, "archive_photo/"])
    except Exception as e:
      print("Error load (", target_tsv, ")", e)

  # ----- concat v1 and v2
  if df_v1 is not None or df_v2 is not None:
    df_archive = pd.concat([df_v1, df_v2])
    json_archive = df_archive.to_json(orient='records', force_ascii=False)

    f = open('../docs/data/archives/' + row.slug + '.js', 'w')
    f.write("const archive_" + row.slug + " = " + json_archive + ";\n"
            + "export default archive_" + row.slug + ";")
    f.close()

    archive_meta[row.slug] = {
      'name': row.name,
      'icon': {
        'name': row.icon_name,
        'size': [row.icon_size_x, row.icon_size_y],
        'anchor': [row.icon_anchor_x, row.icon_anchor_y],
        'popup': [row.popup_x, row.popup_y]
      }
    }

    js_import += "import archive_" + row.slug + " from \"./archives/" + row.slug + ".js\"\n"
    archive_list += "\"" + row.slug + "\": archive_" + row.slug + ","

f = open('../docs/data/archives.js', 'w')
f.write(js_import
        + "export const HASHTAG_LIST = " + json.dumps(archive_meta, ensure_ascii=False) + ";\n"
        + "export default HASHTAG_LIST;\n"
        + "export const ARCHIVES = {" + archive_list[:-1] + "};")
f.close()




### v1 のアーカイブファイル生成コード (duplicated)

# target_hashtags = [479, 702, 805, 700, 880, 508, 776, 685]

# json = "var archives = {"
# for h in target_hashtags:
#   target_tsv = 'tsv/' + str(h) + '.tsv'
#   print("\n--> " + target_tsv)
#   try:
#     df = pd.read_csv(target_tsv, sep='\t')
#     json += str(h) + ":" + df.to_json(orient='records') + ","
#     print(str(df.shape[0]) + " items")
#   except:
#     print("Error: " + target_tsv)
# json += "};"

# f = open('../docs/data/archives.js', 'w')
# f.write(json)
# f.close()
