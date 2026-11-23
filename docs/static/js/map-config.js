// スタイルはビューアと同じサーバー。日本は自前PMTiles、国外・広域はOpenFreeMap。
export const MAP_CONFIG = Object.freeze({
  styleURL: new URL('../map/japan.json?v=6.6', import.meta.url).href,
  pmtilesURL: 'https://tiles.yukimat.jp/japan.pmtiles',
  worldTileJSONURL: 'https://tiles.openfreemap.org/planet',
  worldAttribution: '<a href="https://openfreemap.org/">OpenFreeMap</a> · &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  japanMinZoom: 10, // 広域は世界地図、ズーム10以降は日本PMTilesを優先

  center: [133.91804081661178, 34.66658501665325], // 経度、緯度
  zoom: 11, // Leafletの256pxタイルでのzoom=12と同じ縮尺
  minZoom: 0,
  maxZoom: 18,
});
