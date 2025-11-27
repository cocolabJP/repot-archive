import pandas as pd
import json
import subprocess
import urllib.request
import os
import time
from PIL import Image
import datetime

### v1 データ（変換済み）と v2 データを統合した、アーカイブ生成コード

# この日以降のみをデータ圧縮などの対象にする
target_period_from = datetime.date(2025, 11, 12)
target_period_to   = datetime.date(2026, 1, 1)

df_hashtags = pd.read_csv("archive_list.csv")
print(df_hashtags)

subprocess.call("rm ../docs/data/archives/*.js", shell=True)

js_import = ""
archive_list = ""
archive_meta = {}

# 写真ファイルの中身と拡張子の一致を確認
def check_photo_extension_and_format(photo_path):
  print("check extension and format: " + photo_path)
  img = Image.open(photo_path)
  ext = os.path.splitext(photo_path)[1].lower()
  fmt = "." + img.format.lower().replace("e", "")
  if ext != fmt:
    print("----> not mached! ... ext=", ext, ", fmt=", fmt)
    if ext == ".png":
      img.save(photo_path, format="PNG", optimize=True)
    elif ext == ".jpg":
      img.save(photo_path, format="JPEG", optimize=True)
  else:
    print("----> OK")

# 写真ファイルのリサイズ
def resize_photo(photo_path):
  print("resize: " + photo_path)
  img = Image.open(photo_path)
  max_size = (1920, 1920)
  img_size = img.size
  if img_size[0] > max_size[0] or img_size[1] > max_size[1]:
    img.thumbnail(max_size)
    img.save(photo_path, format="PNG", quality=80, optimize=True, progressive=True)
    print(f"----> resized: {img_size} -> {img.size} ... save_to: {"archive_photo/" + df_row.filename}")
  else:
    print("----> do not need to resize")

# 写真ファイルの圧縮
def compress_photo(photo_path):
  print("compress: " + photo_path)
  if os.path.getsize(photo_path) < 3 * 1024 * 1024:
    print(f"----> {os.path.getsize(photo_path)} is already small enough. skipped.")
    return
  else:
    print("----> start compress...")
  img = Image.open(photo_path)
  ext = os.path.splitext(photo_path)[1].lower()
  if ext in [".jpg", ".jpeg"]:
    # jpegoptim --max=80 --strip-all --all-progressive
    jpegoptim_cmd = [
        "jpegoptim",
        "--max=80",       # 最大画質を80%に
        "--strip-all",    # メタデータ削除
        "--all-progressive"  # プログレッシブJPEGにする
    ]
    result_j = subprocess.run(
        jpegoptim_cmd + [photo_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    if result_j.returncode == 0:
      print(f"----> ✅️ jpegoptim OK: {result_j.stdout}")
    else:
      print(f"----> ❌ jpegoptim err: {result_j.returncode}")
  elif ext == ".png":
    # pngquant --quality=65-80 --ext .png --force
    pngquant_cmd = [
        "pngquant",
        "--quality=65-80",
        "--ext", ".png",
        "--force"
    ]
    optipng_cmd = [
        "optipng",
        "-o7"
    ]
    result_q = subprocess.run(
        pngquant_cmd + [photo_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    if result_q.returncode == 0:
        print(f"----> ✅️ pngquant OK: {result_q.stdout}")
    else:
        print(f"----> ❌ pngquant err: {result_q.returncode}")

    # # optipng ... 処理時間が長い
    # result_o = subprocess.run(
    #     optipng_cmd + [photo_path],
    #     stdout=subprocess.PIPE,
    #     stderr=subprocess.PIPE,
    #     text=True
    # )
    # if result_o.returncode == 0:
    #     print(result_o.stdout)
    # else:
    #     print(f"----> ❌ optipng err: {result_o.stdout} {result_o.stderr}")

def make_thumbnail(photo_path, thumbnail_path):
  print("make thumbnail: " + photo_path)
  img = Image.open(photo_path)
  max_size = (480, 480)
  img.thumbnail(max_size)
  img.save(thumbnail_path, format="PNG", quality=80, optimize=True, progressive=True)


for row in df_hashtags.itertuples():
  print("\n\n[", row.slug, "]")
  # ------------ v1
  df_v1 = None
  if row.v1 != -1:
    target_tsv = 'v1_tsv/' + str(row.v1) + '.tsv'
    print("\n[v1] load csv: " + target_tsv)
    try:
      df_v1 = pd.read_csv(target_tsv, sep='\t')
      for idx, df_row in df_v1.iterrows():
        print(f"\r[v1] {target_tsv} 処理中: {idx+1}/{len(df_v1)}", end="")
        subprocess.call(["rsync", "-u", "v1_photo/" + df_row.filename, "archive_photo/"])
        photo_path = "archive_photo/" + df_row.filename
        photo_date = datetime.datetime.strptime(df_row.filename[0:8], "%Y%m%d").date()
        if photo_date > target_period_from and photo_date < target_period_to:
          print("--> process photo data: ", df_row.filename)
          check_photo_extension_and_format(photo_path)
          resize_photo(photo_path)
          compress_photo(photo_path)
          make_thumbnail(photo_path, "archive_thumb/" + df_row.filename)
          print("done.\n")
    except Exception as e:
      print("Error (", target_tsv, ")", e)

  # ------------ v2
  df_v2 = None
  if row.v2 != -1:
    target_tsv = 'v2_tsv/' + str(row.v2) + '.tsv'

    try:
      print("\n[v2] download csv from server: " + target_tsv)
      remote_url = 'https://repot.sokendo.studio/static/archive/' + str(row.v2) + '.tsv'
      urllib.request.urlretrieve(remote_url, target_tsv)
    except Exception as e:
      print("[v2] Error download (", target_tsv, ")", e)

    try:
      print("[v2] load csv: " + target_tsv)
      df_v2 = pd.read_csv(target_tsv, sep='\t')
      for idx, df_row in df_v2.iterrows():
        print(f"\r[v2] {target_tsv} 処理中: {idx+1}/{len(df_v2)}", end="")
        photo_path = "v2_photo/" + df_row.filename
        photo_date = datetime.datetime.strptime(df_row.filename[0:8], "%Y%m%d").date()
        if not os.path.isfile(photo_path):
          print("\ndownload photo from v2 server: " + df_row.filename)
          remote_url = 'https://repot.sokendo.studio/uploads/original/' + df_row.filename
          urllib.request.urlretrieve(remote_url, photo_path)
        subprocess.call(["rsync", "-u", photo_path, "archive_photo/"])
        if photo_date > target_period_from and photo_date < target_period_to:
          print("\n--> process photo data: ", df_row.filename)
          # 以下、ファイルサイズ削減処理
          photo_path = "archive_photo/" + df_row.filename
          check_photo_extension_and_format(photo_path)
          resize_photo(photo_path)
          compress_photo(photo_path)
          make_thumbnail(photo_path, "archive_thumb/" + df_row.filename)
          print("done.\n")
    except Exception as e:
      print("Error load (", target_tsv, ")", e)

  # ----- concat v1 and v2
  if df_v1 is not None or df_v2 is not None:
    df_archive = pd.concat([df_v1, df_v2])
    df_archive = df_archive.sort_values('timestamp', ascending=False)
    df_archive.reset_index(inplace=True, drop=True)
    df_archive['caution_flag'] = False
    for archive_row in df_archive.itertuples():
      hashtags = archive_row.hashtag_names.split(";")
      for i, h in reversed(list(enumerate(hashtags))):
        if h == row.name:
          hashtags.pop(i)
        if h == '利用上の注意':
          hashtags.pop(i)
          df_archive.at[archive_row.Index, 'caution_flag'] = True
      df_archive.at[archive_row.Index, 'hashtag_names'] = hashtags

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

  print("done.")

f = open('../docs/data/archives.js', 'w')
f.write(js_import
        + "export const HASHTAG_LIST = " + json.dumps(archive_meta, ensure_ascii=False) + ";\n"
        + "export default HASHTAG_LIST;\n"
        + "export const ARCHIVES = {" + archive_list[:-1] + "};")
f.close()

