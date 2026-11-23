const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../docs/static/js/archive-map.js'), 'utf8')
  .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
const config = { styleURL: 'https://tiles.example/japan.json', pmtilesURL: 'https://tiles.example/japan.pmtiles', center: [133, 34], zoom: 11, minZoom: 0, maxZoom: 18 };
const style = { version: 8, sources: { openmaptiles: { type: 'vector', url: 'pmtiles://./japan-old.pmtiles', attribution: 'OSM credit' } },
  glyphs: './fonts/{fontstack}/{range}.pbf', sprite: './sprite', layers: [] };
const dataset = { name: '桜', icon: { name: 'sakura', size: [40, 40], anchor: [20, 20], popup: [0, 0] } };
const posts = [
  { slug: 'one', location_lat: 34, location_lng: 133, caption: '<img src=x onerror=alert(1)>', hashtag_names: ['<b>タグ</b>'], filename: 'one.png' },
  { slug: 'two', location_lat: 35, location_lng: 134, caption: null, hashtag_names: [], filename: 'two.png' },
];
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Events {
  constructor() { this.events = new Map(); }
  on(type, layer, fn) { const handler = fn || layer; if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(handler); return this; }
  off(type, fn) { this.events.get(type)?.delete(fn); return this; }
  once(type, fn) { const handler = (...args) => { this.off(type, handler); fn(...args); }; return this.on(type, handler); }
  emit(type, event = {}) { for (const fn of [...(this.events.get(type) || [])]) fn(event); }
}
function node(tagName) {
  return { tagName, style: {}, children: [], textContent: '', handlers: {}, append(child) { this.children.push(child); },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    set innerHTML(_) { throw new Error('投稿テキストをHTMLとして解釈してはいけない'); },
  };
}
class FakePopup extends Events {
  constructor(options) { super(); this.options = options; this.content = node('popup-content'); this.element = { style: {}, offsetWidth: 216, offsetHeight: 200, querySelector: (selector) => selector === '.archive-popup-body' ? this.body : this.content }; }
  setLngLat(value) { this.position = value; return this; }
  setDOMContent(value) { this.body = value; return this; }
  addTo(map) { this.map = map; this.open = true; return this; }
  isOpen() { return this.open; }
  getElement() { return this.element; }
  getLngLat() { return this.position; }
  setMaxWidth(value) { this.maxWidth = value; }
  remove() { if (this.open) { this.open = false; this.emit('close'); } }
}
class FakeMap extends Events {
  constructor(options) {
    super(); this.options = options; this.sources = new Map(); this.layers = new Map(); this.images = new Map(); this.addedImages = [];
    this.canvas = { style: {} }; this.controls = []; this.point = { x: 300, y: 350 }; this.moving = false; this.pan = [];
    this.touchZoomRotate = { disableRotation() {} }; this.keyboard = { disableRotation() {} };
    queueMicrotask(() => this.emit('style.load'));
  }
  addControl(control, position) { this.controls.push({ control, position }); }
  setStyle(style) { this.style = style; this.sources.clear(); this.layers.clear(); this.images.clear(); queueMicrotask(() => { this.emit('style.load'); this.emit('idle'); }); }
  getSource(id) { return this.sources.get(id); }
  addSource(id, source) { this.sources.set(id, { data: source.data, setData(data) { this.data = data; } }); }
  getLayer(id) { return this.layers.get(id); }
  addLayer(layer) { this.layers.set(layer.id, layer); }
  setLayoutProperty(id, key, value) { this.layers.get(id).layout[key] = value; }
  hasImage(id) { return this.images.has(id); }
  addImage(id, image, options) { this.images.set(id, image); this.addedImages.push({ id, options }); }
  isStyleLoaded() { return false; } // GeoJSON更新処理中でも描画を更新できることを確認する。
  queryRenderedFeatures() { return this.features || []; }
  getCanvas() { return this.canvas; }
  getZoom() { return 11; }
  stop() { if (this.moving) { this.moving = false; this.emit('moveend'); } }
  flyTo(options) { this.flight = options; this.moving = options.duration > 0; if (!this.moving) this.emit('moveend'); }
  isMoving() { return this.moving; }
  getContainer() { return { clientWidth: 600, clientHeight: 700 }; }
  project() { return this.point; }
  panBy(offset) { this.pan.push(offset); this.point = { x: this.point.x - offset[0], y: this.point.y - offset[1] }; }
  resize() { this.resized = true; }
  remove() { this.removed = true; }
}
function fixture(options = {}) {
  const statuses = []; const selected = []; let opened = 0;
  const library = { Map: FakeMap, Popup: FakePopup, NavigationControl: class {}, AttributionControl: class { constructor(options) { this.options = options; } },
    addProtocol(name) { assert.equal(name, 'pmtiles'); } };
  const context = { MAP_CONFIG: config, URL, AbortController, console: { warn() {} }, setTimeout, clearTimeout, document: { createElement: node } };
  vm.runInNewContext(source + '\nglobalThis.api = { ArchiveMap, isValidLocation, prepareMapStyle };', context);
  const map = new context.api.ArchiveMap('map', { config, library, pmtilesLibrary: { Protocol: class { tile() {} } },
    fetcher: async () => ({ ok: true, json: async () => structuredClone(style) }), iconLoader: async () => ({ data: [] }),
    onStatus: (value) => statuses.push(value), onSelect: (slug) => selected.push(slug), onPopupOpen: () => opened++, ...options });
  return { map, native: map.map, statuses, selected, get opened() { return opened; }, ...context.api };
}

test('配布スタイルの日付付きPMTiles参照を絶対URLに補正し、権利表示とフォントを保持する', async () => {
  const f = fixture(); await f.map.ready;
  const prepared = f.prepareMapStyle(style, config);
  assert.equal(prepared.sources.openmaptiles.url, 'pmtiles://https://tiles.example/japan.pmtiles');
  assert.equal(prepared.sources.openmaptiles.attribution, 'OSM credit');
  assert.equal(prepared.glyphs, 'https://tiles.example/fonts/{fontstack}/{range}.pbf');
  assert.equal(prepared.sprite, 'https://tiles.example/sprite');
  assert.equal(style.sources.openmaptiles.url, 'pmtiles://./japan-old.pmtiles');
  assert.throws(() => f.prepareMapStyle({ version: 8, sources: {}, layers: [] }, config), /PMTiles/);
});

test('緯度経度の欠損・範囲外を除外し、経度・緯度の順でGeoJSONを描画して期間変更を反映する', async () => {
  const f = fixture(); await f.map.ready;
  for (const patch of [{ location_lat: null }, { location_lat: NaN }, { location_lat: 91 }, { location_lng: '133' },
    { location_lng: 181 }, { location_lat: -1, location_lng: -1 }, { location_lat: 0, location_lng: 0 }]) assert.equal(f.isValidLocation({ ...posts[0], ...patch }), false);
  f.map.setPosts([...posts, { ...posts[0], slug: 'missing', location_lat: null }], dataset, (post) => post.filename);
  await flush();
  const data = f.native.getSource('repot-posts').data;
  assert.equal(data.features.length, 2);
  assert.deepEqual(Array.from(data.features[0].geometry.coordinates), [133, 34]);
  f.map.setPosts([posts[1]], dataset, (post) => post.filename);
  await flush();
  assert.deepEqual(Array.from(f.native.getSource('repot-posts').data.features, (feature) => feature.properties.slug), ['two']);
  assert.equal(f.map.hasPost('one'), false);
});

test('アイコンの読込中にデータセットを変えても古い地点・アイコンを再表示しない', async () => {
  const pending = new Map();
  const f = fixture({ iconLoader: (icon) => new Promise((resolve) => pending.set(icon.name, resolve)) });
  await f.map.ready;
  f.map.setPosts([posts[0]], dataset, (post) => post.filename);
  f.map.setPosts([posts[1]], { ...dataset, icon: { ...dataset.icon, name: 'udon' } }, (post) => post.filename);
  pending.get('udon')({ data: [] }); await flush();
  pending.get('sakura')({ data: [] }); await flush();
  assert.deepEqual(Array.from(f.native.getSource('repot-posts').data.features, (feature) => feature.properties.slug), ['two']);
  assert.equal(f.native.getLayer('repot-markers').layout['icon-image'], 'repot-udon-40x40');
});

test('マーカーから一覧へ連動し、コメント・タグをHTMLとして解釈せず写真付きポップアップを開く', async () => {
  const f = fixture(); await f.map.ready;
  f.map.setPosts(posts, dataset, (post) => 'https://data.cocolab.jp/repot-thumb/' + post.filename); await flush();
  f.native.features = [{ properties: { slug: 'one' } }]; f.native.emit('click', { point: [0, 0] });
  assert.deepEqual(f.selected, ['one']);
  const body = f.map.popup.body;
  assert.equal(body.children[0].src, 'https://data.cocolab.jp/repot-thumb/one.png');
  assert.equal(body.children[1].textContent, posts[0].caption);
  assert.equal(body.children[2].children[1].textContent, posts[0].hashtag_names[0]);
  f.map.setPosts([], dataset, (post) => post.filename); await flush();
  f.native.emit('click', { point: [0, 0] });
  assert.deepEqual(f.selected, ['one']);
});

test('移動を減らす設定では一度だけ開き、連続選択・移動中の期間変更で古いポップアップを開かない', async () => {
  const f = fixture(); await f.map.ready;
  f.map.setPosts(posts, dataset, (post) => post.filename); await flush();
  f.map.focusPost('one', { animate: false });
  assert.equal(f.opened, 1);
  f.map.focusPost('one'); f.map.focusPost('two');
  f.native.moving = false; f.native.emit('moveend');
  assert.equal(f.opened, 2);
  assert.deepEqual(Array.from(f.map.popup.position), [134, 35]);
  f.map.focusPost('one'); f.map.setPosts([], dataset, (post) => post.filename);
  f.native.moving = false; f.native.emit('moveend');
  assert.equal(f.map.popup, null);
  assert.equal(f.opened, 2);
});

test('シート・ヘッダーの間にポップアップを収め、PCでは通常の余白に戻す', async () => {
  const f = fixture(); await f.map.ready;
  f.map.setPosts(posts, dataset, (post) => post.filename); await flush();
  f.native.point = { x: 300, y: 500 };
  f.map.setViewport({ top: 100, bottom: 260 }); f.map.openPopup('one');
  assert.equal(f.map.popup.content.style.maxHeight, '316px');
  assert.deepEqual(Array.from(f.native.pan.at(-1)), [0, 60]);
  f.map.setViewport({ top: 16, bottom: 16 });
  assert.equal(f.map.popup.content.style.maxHeight, '644px');
  f.map.setViewport({ top: 100, bottom: 580 });
  assert.equal(f.map.popup.element.style.visibility, 'hidden');
});

test('スタイルを再読込しても地点を復元し、通信失敗後は再試行できる', async () => {
  let fails = true;
  const f = fixture({ fetcher: async () => { if (fails) throw new Error('offline'); return { ok: true, json: async () => style }; } });
  await f.map.ready;
  assert.ok(f.statuses.at(-1).error);
  f.map.setPosts(posts, dataset, (post) => post.filename); await flush();
  fails = false; await f.map.reload(); await flush();
  assert.equal(f.statuses.at(-1).error, '');
  assert.equal(f.native.getSource('repot-posts').data.features.length, 2);
  await f.map.reload(); await flush();
  assert.equal(f.native.getSource('repot-posts').data.features.length, 2);
  f.map.remove(); assert.equal(f.native.removed, true);
});


test('ブラウザのfetchをコントローラーのメソッドとして呼ばずにスタイルを取得する', async () => {
  const f = fixture({ fetcher: function () {
    'use strict';
    assert.equal(this, undefined);
    return Promise.resolve({ ok: true, json: async () => style });
  } });
  await f.map.ready; await flush();
  assert.equal(f.statuses.at(-1).error, '');
});
