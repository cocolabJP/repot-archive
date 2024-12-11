import archive_sakusaku from "./archives/sakusaku.js"
import archive_hanasaku from "./archives/hanasaku.js"
import archive_pxky from "./archives/pxky.js"
import archive_localGourmet from "./archives/localGourmet.js"
import archive_opendataIceCream from "./archives/opendataIceCream.js"
import archive_chushikokuSakana from "./archives/chushikokuSakana.js"
import archive_koriyamaSakuraMimamori from "./archives/koriyamaSakuraMimamori.js"
import archive_sawanoNaramachiJikken from "./archives/sawanoNaramachiJikken.js"
export const HASHTAG_LIST = {"sakusaku": {"name": "桜咲", "icon": {"name": "sakura", "size": [40, 40], "anchor": [20, 20], "popup": [0, 0]}}, "hanasaku": {"name": "花咲", "icon": {"name": "default", "size": [40, 50], "anchor": [20, 50], "popup": [0, -25]}}, "pxky": {"name": "pxky", "icon": {"name": "pxky", "size": [40, 50], "anchor": [20, 50], "popup": [0, -25]}}, "localGourmet": {"name": "ご当地グルメ", "icon": {"name": "default", "size": [40, 50], "anchor": [20, 50], "popup": [0, -25]}}, "opendataIceCream": {"name": "オープンデータソフトクリーム", "icon": {"name": "ice-cream", "size": [32, 50], "anchor": [16, 50], "popup": [0, -25]}}, "chushikokuSakana": {"name": "中四国魚", "icon": {"name": "default", "size": [40, 50], "anchor": [20, 50], "popup": [0, -25]}}, "koriyamaSakuraMimamori": {"name": "郡山桜見守り", "icon": {"name": "sakura", "size": [40, 40], "anchor": [20, 20], "popup": [0, 0]}}, "sawanoNaramachiJikken": {"name": "さわのならまち実験", "icon": {"name": "default", "size": [40, 50], "anchor": [20, 50], "popup": [0, -25]}}};
export default HASHTAG_LIST;
export const ARCHIVES = {"sakusaku": archive_sakusaku,"hanasaku": archive_hanasaku,"pxky": archive_pxky,"localGourmet": archive_localGourmet,"opendataIceCream": archive_opendataIceCream,"chushikokuSakana": archive_chushikokuSakana,"koriyamaSakuraMimamori": archive_koriyamaSakuraMimamori,"sawanoNaramachiJikken": archive_sawanoNaramachiJikken};