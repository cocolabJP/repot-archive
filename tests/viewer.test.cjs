const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../docs/static/js/main.js'), 'utf8')
  .replace(/^import[^\n]+\n/, '');

function viewer() {
  const dialogs = () => ({ open: false, showModal() { this.open = true; }, close() { this.open = false; } });
  const elements = {
    license: dialogs(), about: dialogs(), 'period-setting': dialogs(),
    'form-period-from': { value: '' }, 'form-period-to': { value: '' },
    'list-new': { getBoundingClientRect: () => ({ top: 500 }) },
  };
  const focus = { datasets: 0, info: 0 };
  const list = { scrollTop: 20, getBoundingClientRect: () => ({ top: 400 }), scrollTo(options) { this.lastScroll = options; } };
  const win = {
    innerWidth: 393, innerHeight: 852,
    location: { search: '', hash: '' },
    history: { replaceState(_state, _title, value) { win.location.hash = value; } },
    matchMedia: () => ({ matches: true }),
  };
  const posts = [
    { slug: 'new', timestamp: Date.parse('2026-06-01T12:00:00Z') / 1000 },
    { slug: 'summer', timestamp: Date.parse('2025-08-01T12:00:00Z') / 1000 },
    { slug: 'missing', timestamp: Date.parse('2025-01-01T12:00:00Z') / 1000, location_lat: -1, location_lng: -1 },
    { slug: 'old', timestamp: Date.parse('2024-07-01T12:00:00Z') / 1000 },
  ];
  let app;
  vm.runInNewContext(source, {
    HASHTAG_LIST: { fish: { name: '魚' }, jelly: { name: 'クラゲ' }, empty: { name: '空' } },
    ARCHIVES: { fish: posts, jelly: posts.slice(0, 1), empty: [] },
    window: win, document: { getElementById: (id) => elements[id] }, URLSearchParams,
    setTimeout: (fn) => fn(), L: { point: (x, y) => ({ x, y }) },
    Vue: function(options) {
      app = options.data;
      for (const [name, fn] of Object.entries(options.methods)) app[name] = fn.bind(app);
      for (const [name, fn] of Object.entries(options.computed)) Object.defineProperty(app, name, { get: fn.bind(app) });
      app.$nextTick = (fn) => fn();
      app.$refs = {
        photoList: list, brand: { getBoundingClientRect: () => ({ bottom: 70 }) },
        datasetTrigger: { focus() { focus.datasets++; }, getBoundingClientRect: () => ({ bottom: 68 }) },
        infoTrigger: { focus() { focus.info++; } },
        datasetPicker: { contains: (target) => target === 'dataset', querySelector: () => ({ querySelector: () => null }) },
        infoMenu: { contains: (target) => target === 'info' },
        viewContainer: { getBoundingClientRect: () => ({ left: 180, width: win.innerWidth - 180 }) },
      };
      options.created.call(app);
      return app;
    },
  });
  app.updateScreenSize();
  const capture = new Set();
  const handle = { setPointerCapture: (id) => capture.add(id), hasPointerCapture: (id) => capture.has(id), releasePointerCapture: (id) => capture.delete(id) };
  const pointer = (y, time = 0, id = 7) => ({ clientY: y, timeStamp: time, pointerId: id, isPrimary: true, button: 0, currentTarget: handle });
  return { app, elements, win, list, focus, pointer };
}

test('上下のスワイプでシートを広げたり縮めたりでき、直後のclickで二重に切り替わらない', () => {
  const { app, pointer } = viewer();
  app.startSheetDrag(pointer(700));
  app.moveSheetDrag(pointer(50, 100));
  assert.equal(app.sheetHeight, app.sheetStops[2]);
  app.endSheetDrag(pointer(50, 200));
  assert.equal(app.sheet.level, 2);
  app.toggleSheet({ detail: 1 });
  assert.equal(app.sheet.level, 2);
  app.startSheetDrag(pointer(50, 1000));
  app.endSheetDrag(pointer(2000, 1500));
  assert.equal(app.sheet.level, 0);
  assert.equal(app.sheetHeight, app.sheetStops[0]);
});

test('短いフリック・タップ・キーボードで高さを変更できる', () => {
  const { app, pointer } = viewer();
  app.startSheetDrag(pointer(700));
  app.endSheetDrag(pointer(650, 100));
  assert.equal(app.sheet.level, 2);
  app.toggleSheet({ detail: 1 });
  assert.equal(app.sheet.level, 2);
  app.toggleSheet({ detail: 0 });
  assert.equal(app.sheet.level, 0);
  app.changeSheetLevel(1);
  assert.equal(app.sheet.level, 1);
  app.changeSheetLevel(-20);
  assert.equal(app.sheet.level, 0);
});

test('別の指の操作や中断ではシートを誤移動せず、画面回転後もヘッダーに重ならない', () => {
  const { app, win, pointer } = viewer();
  app.startSheetDrag(pointer(700));
  const height = app.sheetHeight;
  app.moveSheetDrag(pointer(0, 100, 8));
  assert.equal(app.sheetHeight, height);
  app.cancelSheetDrag();
  assert.equal(app.sheet.level, 1);
  app.sheet.level = 2;
  win.innerWidth = 852;
  win.innerHeight = 393;
  app.updateScreenSize();
  assert.ok(app.sheetHeight <= win.innerHeight - app.view.headerBottom);
  assert.ok(app.sheetStops.every((stop) => stop >= 0 && stop <= app.sheetStops[2]));
  assert.ok(app.sheetStops[0] < app.sheetStops[1] && app.sheetStops[1] < app.sheetStops[2]);
});

test('データセット切替はURL・件数・期間・選択写真・メニューを更新する', () => {
  const { app, win, list } = viewer();
  app.menus.datasets = true;
  app.selectedSlug = 'previous';
  app.setHashtag('fish');
  assert.equal(win.location.hash, '#fish');
  assert.equal(app.selectedDatasetName, '魚');
  assert.equal(app.displayCount, 4);
  assert.equal(app.selectedSlug, null);
  assert.equal(app.menus.datasets, false);
  assert.equal(list.scrollTop, 0);
  app.setHashtag('unknown');
  assert.equal(app.hashtag.selected, 'fish');
  app.setHashtag('empty');
  assert.equal(app.displayCount, 0);
  assert.equal(app.displayFrom, '—');
  assert.equal(app.displayTo, '—');
});

test('年・全期間・直接入力による絞り込みを維持し、不正な期間で現在の条件を壊さない', () => {
  const { app, elements } = viewer();
  app.setHashtag('fish');
  app.setPeriodYear(2025);
  assert.equal(app.displayCount, 2);
  assert.deepEqual(Array.from(app.filteredArchives, (post) => post.slug), ['summer', 'missing']);
  assert.deepEqual(Array.from(app.periodYears), [2026, 2025, 2024]);
  const from = app.period.from.getTime();
  elements['form-period-from'].value = '2026-12-01';
  elements['form-period-to'].value = '2025-01-01';
  app.setPeriod();
  assert.ok(app.periodError);
  assert.equal(app.period.from.getTime(), from);
  app.setPeriodAll();
  assert.equal(app.displayCount, 4);
  assert.equal(app.periodError, '');
});

test('写真の選択でシートを戻し、地図の写真と一覧の対象カードを表示する', () => {
  const { app, list } = viewer();
  let opened = 0;
  let flown = false;
  app.map = { getCenter: () => ({ equals: () => false }), getZoom: () => 12, flyTo() { flown = true; } };
  app.markers.new = { getLatLng: () => ({ lat: 34, lng: 133 }), openPopup() { opened++; } };
  app.sheet.level = 2;
  app.showInMap('new');
  assert.equal(app.sheet.level, 1);
  assert.equal(app.selectedSlug, 'new');
  assert.ok(flown);
  assert.equal(opened, 1);
  assert.equal(list.lastScroll.top, 112);
  app.showInMap('missing');
  assert.equal(app.selectedSlug, 'missing');
  assert.equal(opened, 1);
});

test('情報メニューとデータセット一覧は排他的で、Escapeや枠外タップで閉じる', () => {
  const { app, focus } = viewer();
  app.openDatasetMenu();
  app.toggleInfoMenu();
  assert.equal(app.menus.datasets, false);
  assert.equal(app.menus.info, true);
  let prevented = false;
  app.onKeydown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(app.menus.info, false);
  assert.ok(prevented);
  assert.equal(focus.info, 1);
  app.openDatasetMenu();
  app.onOutsidePointer({ target: 'outside' });
  assert.equal(app.menus.datasets, false);
});

test('従来のハッシュ・クエリ指定・ライセンスURLを維持する', () => {
  const { app, win, elements } = viewer();
  win.location.search = '?h=fish';
  app.checkQueryStrings();
  assert.equal(app.hashtag.selected, 'fish');
  win.location.hash = '#license';
  app.checkHash();
  assert.equal(elements.license.open, true);
  app.map = { invalidateSize() {} };
  app.putMarkers = () => {};
  win.location.hash = '#jelly';
  app.checkHash();
  assert.equal(elements.license.open, false);
  assert.equal(app.hashtag.selected, 'jelly');
  win.location.hash = '#%invalid';
  assert.doesNotThrow(() => app.checkHash());
});

test('1200pxを境にPCとスマホを切り替え、データ・期間・地図インスタンスを保つ', () => {
  const { app, win } = viewer();
  const positions = [];
  const map = { invalidateSize() {}, attributionControl: { setPosition(value) { positions.push(value); } } };
  app.setHashtag('fish');
  app.setPeriodYear(2025);
  app.selectedSlug = 'summer';
  app.map = map;
  win.innerWidth = 1199;
  app.updateScreenSize();
  assert.equal(app.isMobile, true);
  app.menus.datasets = true;
  win.innerWidth = 1200;
  app.updateScreenSize();
  assert.equal(app.isMobile, false);
  assert.equal(app.menus.datasets, false);
  assert.equal(app.view.headerBottom, 0);
  assert.equal(app.mapWidth, '50%');
  assert.equal(app.listWidth, '50%');
  assert.equal(app.displayCount, 2);
  assert.equal(app.selectedSlug, 'summer');
  assert.equal(app.map, map);
  win.innerWidth = 393;
  app.updateScreenSize();
  assert.equal(app.isMobile, true);
  assert.deepEqual(positions, ['bottomleft', 'bottomright', 'bottomleft']);
  assert.equal(app.displayCount, 2);
});

test('PCの境界線をドラッグして左右の幅を調整でき、スマホでは動作しない', () => {
  const { app, win, pointer } = viewer();
  win.innerWidth = 1400;
  app.updateScreenSize();
  app.startDragDivider({ ...pointer(0), clientX: 790 });
  app.onDragDivider({ ...pointer(0), clientX: 1100 });
  assert.ok(app.view.divideRatio > 0.7 && app.view.divideRatio < 0.8);
  app.onDragDivider({ ...pointer(0), clientX: 5000 });
  assert.equal(app.mapWidth, '80%');
  app.stopDragDivider(pointer(0));
  assert.equal(app.view.isDragging, false);
  app.resizeDivider(-1);
  assert.equal(app.mapWidth, '20%');
  assert.equal(app.listWidth, '80%');
  win.innerWidth = 393;
  app.updateScreenSize();
  app.startDragDivider(pointer(0));
  assert.equal(app.view.isDragging, false);
});

test('PCのポップアップにスマホのボトムシート用余白を適用しない', () => {
  const { app, win } = viewer();
  const popup = { options: {}, isOpen: () => true, update() {} };
  app.map = { invalidateSize() {}, getSize: () => ({ y: 700 }) };
  win.innerWidth = 1400;
  app.updateScreenSize();
  app.updatePopupLayout(popup);
  assert.equal(popup.options.autoPanPaddingBottomRight.y, 16);
  assert.equal(popup.options.maxHeight, 636);
  win.innerWidth = 393;
  app.updateScreenSize();
  app.updatePopupLayout(popup);
  assert.equal(popup.options.autoPanPaddingBottomRight.y, app.sheetHeight + 16);
});
