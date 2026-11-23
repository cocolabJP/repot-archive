const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../docs/static/js/hybrid-basemap.js'), 'utf8').replace(/^export /gm, '');
const context = { URL, AbortController, DOMException };
vm.runInNewContext(source + '\nglobalThis.api = { HybridBasemap, intersectsArchive };', context);
const { HybridBasemap, intersectsArchive } = context.api;
const config = { worldTileJSONURL: 'https://world.test/planet', japanMinZoom: 10 };
const header = { minLon: 122.56, minLat: 20.08, maxLon: 154.47, maxLat: 45.82, maxZoom: 14 };
const base = 'repot-basemap://map-1';
const coordinates = (lon, lat, zoom) => [zoom, Math.floor((lon + 180) / 360 * 2 ** zoom),
  Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** zoom)];
const japan = coordinates(133.918, 34.6665, 11);
const paris = coordinates(2.35, 48.86, 11);

function fixture() {
  const calls = []; const japanCalls = [];
  const state = { tile: { data: new Uint8Array([1, 2]).buffer }, metadataError: false, japanError: false };
  const archive = { getHeader: async () => header, getMetadata: async () => ({ name: 'Japan', vector_layers: [{ id: 'water' }] }),
    async getZxy(...args) { japanCalls.push(args); if (state.japanError) throw new Error('Japan offline'); return state.tile; } };
  const engine = new HybridBasemap(archive, config, async (url, options) => {
    calls.push({ url, options });
    if (url === config.worldTileJSONURL) return { ok: !state.metadataError, status: state.metadataError ? 503 : 200,
      json: async () => ({ tiles: ['https://world.test/{z}/{x}/{y}.pbf'], maxzoom: 14 }) };
    return { ok: true, arrayBuffer: async () => new Uint8Array([3, 4]).buffer,
      headers: { get: (key) => key === 'Cache-Control' ? 'public,max-age=3600' : null } };
  });
  const request = (coords, signal = new AbortController().signal) => engine.request(base + '/' + coords.join('/'), signal, base);
  return { state, engine, calls, japanCalls, archive, request };
}

test('配信範囲を全世界へ広げ、国内外とも同じベクトル形式のタイルURLを返す', async () => {
  const f = fixture();
  const result = await f.engine.request(base, new AbortController().signal, base);
  assert.deepEqual(Array.from(result.data.bounds), [-180, -85.05112878, 180, 85.05112878]);
  assert.equal(result.data.tiles[0], base + '/{z}/{x}/{y}');
  assert.equal(result.data.maxzoom, 14);
});

test('国内の詳細表示はPMTilesを使い、国外では日本のタイルを取りに行かない', async () => {
  const f = fixture();
  assert.deepEqual([...new Uint8Array((await f.request(japan)).data)], [1, 2]);
  assert.equal(f.japanCalls.length, 1);
  assert.equal(f.calls.length, 1);
  const foreign = await f.request(paris);
  assert.deepEqual([...new Uint8Array(foreign.data)], [3, 4]);
  assert.equal(f.japanCalls.length, 1);
  assert.equal(foreign.cacheControl, 'public,max-age=3600');
  assert.equal(intersectsArchive(...paris, header), false);
});

test('広域表示では世界地図を使い、日本以外が同じタイル内で欠けないようにする', async () => {
  const f = fixture();
  await f.request(coordinates(135, 35, 3));
  assert.equal(f.japanCalls.length, 0);
  assert.equal(f.calls.length, 2);
});

test('日本の範囲内でも空のタイルや通信失敗があれば世界地図で補完する', async () => {
  for (const mode of ['missing', 'empty', 'error']) {
    const f = fixture();
    if (mode === 'missing') f.state.tile = undefined;
    else if (mode === 'empty') f.state.tile = { data: new ArrayBuffer(0) };
    else f.state.japanError = true;
    assert.deepEqual([...new Uint8Array((await f.request(japan)).data)], [3, 4]);
  }
});

test('世界地図の配信情報を取得できなくても国内は表示でき、再試行できる', async () => {
  const f = fixture(); f.state.metadataError = true;
  assert.deepEqual([...new Uint8Array((await f.request(japan)).data)], [1, 2]);
  await assert.rejects(f.request(paris), /世界地図/);
  f.state.metadataError = false; f.engine.reset();
  assert.deepEqual([...new Uint8Array((await f.request(paris)).data)], [3, 4]);
});

test('日本のサーバーに接続できなくても世界地図で国内外を表示できる', async () => {
  const f = fixture();
  f.archive.getHeader = async () => { throw new Error('Japan offline'); };
  const result = await f.engine.request(base, new AbortController().signal, base);
  assert.equal(result.data.maxzoom, 14);
  assert.deepEqual([...new Uint8Array((await f.request(japan)).data)], [3, 4]);
  assert.deepEqual([...new Uint8Array((await f.request(paris)).data)], [3, 4]);
  assert.equal(f.japanCalls.length, 0);
});

test('中止されたリクエストでは補完通信をせず、不正な座標も拒否する', async () => {
  const f = fixture(); const controller = new AbortController();controller.abort();
  await assert.rejects(f.request(japan, controller.signal), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  const moving = new AbortController();
  f.archive.getZxy = async () => { moving.abort(); return undefined; };
  await assert.rejects(f.request(japan, moving.signal), { name: 'AbortError' });
  assert.equal(f.calls.length, 1); // 配信情報だけを取得し、国外のタイルは取得しない。
  await assert.rejects(f.request([1, 9, 0]), /範囲外/);
});
