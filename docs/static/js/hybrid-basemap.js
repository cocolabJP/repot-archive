// 日本のPMTilesに含まれないタイルを、同じOpenMapTiles形式の世界地図で補う。
// 国内外でスタイルや地図インスタンスを切り替えないため、写真・選択状態も維持する。
const registries = new WeakMap();

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export function intersectsArchive(z, x, y, header) {
  const count = 2 ** z;
  const longitude = (column) => column / count * 360 - 180;
  const latitude = (row) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / count))) * 180 / Math.PI;
  return longitude(x + 1) >= header.minLon && longitude(x) <= header.maxLon
    && latitude(y) >= header.minLat && latitude(y + 1) <= header.maxLat;
}

export class HybridBasemap {
  constructor(archive, config, fetcher = fetch) {
    this.archive = archive;
    this.config = config;
    this.fetcher = (url, options) => fetcher(url, options);
    this.metadata = null;
    this.abort = new AbortController();
  }

  reset() { this.metadata = null; }

  async prepare() {
    if (!this.metadata) {
      const pending = Promise.all([
        Promise.all([this.archive.getHeader(), this.archive.getMetadata()])
          .then(([header, metadata]) => ({ header, metadata }))
          .catch((japanError) => ({ japanError })),
        this.fetcher(this.config.worldTileJSONURL, { signal: this.abort.signal }).then(async (response) => {
          if (!response.ok) throw new Error(`世界地図: HTTP ${response.status}`);
          const tilejson = await response.json();
          if (!Array.isArray(tilejson.tiles) || !tilejson.tiles.length || tilejson.tiles.some((url) => typeof url !== 'string' || !url.startsWith('https://'))) {
            throw new Error('世界地図の配信情報が不正です。');
          }
          return { tilejson };
        }).catch((error) => {
          aborted(this.abort.signal);
          // 世界地図だけが停止していても、日本の地図は利用できるようにする。
          return { error };
        }),
      ]).then(([japan, world]) => {
        aborted(this.abort.signal);
        if (!japan.header && !world.tilejson) throw japan.japanError || world.error;
        return { ...japan, ...world };
      });
      this.metadata = pending;
      pending.catch(() => { if (this.metadata === pending) this.metadata = null; });
    }
    return this.metadata;
  }

  async request(url, signal, ownURL) {
    aborted(signal);
    const path = new URL(url).pathname.split('/').filter(Boolean);
    const info = await this.prepare();
    aborted(signal);
    if (!path.length) {
      const maxzoom = info.header?.maxZoom ?? info.tilejson.maxzoom;
      return { data: { ...(info.metadata || info.tilejson), tiles: [`${ownURL}/{z}/{x}/{y}`],
        minzoom: 0, maxzoom: Math.min(maxzoom, info.tilejson?.maxzoom ?? maxzoom),
        bounds: [-180, -85.05112878, 180, 85.05112878],
      } };
    }
    if (path.length !== 3 || path.some((value) => !/^\d+$/.test(value))) throw new Error('地図タイルの座標が不正です。');
    const [z, x, y] = path.map(Number);
    if (z > 24 || x >= 2 ** z || y >= 2 ** z) throw new Error('地図タイルの座標が範囲外です。');
    // 広域表示は世界地図を使い、日本以外の陸地が同じタイル内で欠けるのを避ける。
    const tryJapan = info.header && (z >= this.config.japanMinZoom || !info.tilejson) && intersectsArchive(z, x, y, info.header);
    let japanError;
    if (tryJapan) {
      try {
        const tile = await this.archive.getZxy(z, x, y, signal);
        aborted(signal);
        if (tile?.data?.byteLength) return tile;
      } catch (error) {
        aborted(signal);
        japanError = error;
      }
    }
    aborted(signal);
    if (!info.tilejson) throw japanError || info.error || new Error('世界地図を取得できません。');
    const template = info.tilejson.tiles[(x + y) % info.tilejson.tiles.length];
    const tileURL = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const response = await this.fetcher(tileURL, { signal });
    if (!response.ok) throw new Error(`世界地図タイル: HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    aborted(signal);
    return { data, cacheControl: response.headers.get('Cache-Control') || undefined, expires: response.headers.get('Expires') || undefined };
  }

  remove() { this.abort.abort(); }
}

export function registerHybridBasemap(library, pmtilesLibrary, config, fetcher) {
  let registry = registries.get(library);
  if (!registry) {
    registry = { nextId: 0, sources: new Map() };
    library.addProtocol('repot-basemap', (params, controller) => {
      const source = registry.sources.get(new URL(params.url).hostname);
      if (!source) throw new Error('地図は既に終了しています。');
      return source.engine.request(params.url, controller.signal, source.url);
    });
    registries.set(library, registry);
  }
  const id = `map-${++registry.nextId}`;
  const url = `repot-basemap://${id}`;
  const engine = new HybridBasemap(new pmtilesLibrary.PMTiles(config.pmtilesURL), config, fetcher);
  registry.sources.set(id, { engine, url });
  return { url, reset: () => engine.reset(), remove: () => {
    engine.remove();
    registry.sources.delete(id);
    if (!registry.sources.size) { library.removeProtocol('repot-basemap'); registries.delete(library); }
  } };
}
