### v1 データを v2 に適合するように変換するコード
import pandas as pd
import subprocess
import hashlib
import random

if input('コンバートを開始すると、既存のファイル名が変更されます。\n開始しますか？\t(Yes/No): ') == 'Yes':

  df_hashtags = pd.read_csv("archive_list.csv")
  print(df_hashtags)

  subprocess.call("rm v1_photo/*.png", shell=True)

  for row in df_hashtags.itertuples():
    print("\n[", row.slug, "]")
    # ------------ v1
    if row.v1 != -1:
      target_tsv = 'v1_tsv-original/' + str(row.v1) + '.tsv'
      print("load: " + target_tsv)
      try:
        df_data = pd.read_csv(target_tsv, sep='\t')

        for idx, df_row in df_data.iterrows():
          h = hashlib.md5(str(random.random()).encode()).hexdigest()
          new_slug = df_row.filename[4:-4] + "_" + h[:5]

          # rename/copy photo
          # print(df_row.filename, "---(rename)--->", new_slug + ".png")
          subprocess.call(["cp", "v1_photo-original/" + df_row.filename, "v1_photo/" + new_slug + ".png"])

          # update tsv
          df_data.at[idx, 'slug'] = new_slug
          df_data.at[idx, 'filename'] = new_slug + ".png"

        # export new tsv compatible with v2
        df_data = df_data.drop(['id', 'user_id', 'created_at', 'updated_at'], axis='columns')
        df_data.to_csv('v1_tsv/' + str(row.v1) + '.tsv', sep='\t', index=False)

      except Exception as e:
        print("Error (", target_tsv, ")", e)

else:
  print("--> 中止しました")
