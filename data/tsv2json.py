import pandas as pd

target_hashtags = [479, 702, 805, 700, 880, 508, 776]

json = "var archives = {"
for h in target_hashtags:
  target_tsv = 'tsv/' + str(h) + '.tsv'
  print("\n--> " + target_tsv)
  try:
    df = pd.read_csv(target_tsv, sep='\t')
    json += str(h) + ":" + df.to_json(orient='records') + ","
    print(str(df.shape[0]) + " items")
  except:
    print("Error: " + target_tsv)
json += "};"

f = open('../docs/data/archives.js', 'w')
f.write(json)
f.close()
