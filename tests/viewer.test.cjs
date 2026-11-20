const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../docs/static/js/main.js'), 'utf8')
  .replace(/^import[^\n]+\n/, '');

function viewer(options = {}) {
  const eventTarget = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatch(type) { for (const fn of listeners.get(type) || []) fn(); },
    };
  };
  const dialogs = () => ({ open: false, showModal() { this.open = true; }, close() { this.open = false; } });
  const elements = {
    license: dialogs(), about: dialogs(), 'period-setting': dialogs(),
    'form-period-from': { value: '' }, 'form-period-to': { value: '' },
    'list-new': { getBoundingClientRect: () => ({ top: 500 }) },
  };
  const focus = { datasets: 0, info: 0 };
  const list = { scrollTop: 20, getBoundingClientRect: () => ({ top: 400 }), scrollTo(options) { this.lastScroll = options; } };
  const frames = new Map();
  let nextFrame = 0;
  const win = {
    ...eventTarget(),
    innerWidth: options.width || 393, innerHeight: options.height || 852,
    layoutHeight: options.layoutHeight,
    visualViewport: options.visualViewport ? { ...eventTarget(), ...options.visualViewport } : undefined,
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    location: { search: '', hash: '' },
    history: { replaceState(_state, _title, value) { win.location.hash = value; } },
    matchMedia: () => ({ matches: true }),
  };
  const doc = {
    ...eventTarget(), getElementById: (id) => elements[id],
    documentElement: {
      get clientHeight() { return win.layoutHeight || win.innerHeight; },
      get clientWidth() { return win.innerWidth; },
    },
  };
  const posts = [
    { slug: 'new', timestamp: Date.parse('2026-06-01T12:00:00Z') / 1000 },
    { slug: 'summer', timestamp: Date.parse('2025-08-01T12:00:00Z') / 1000 },
    { slug: 'missing', timestamp: Date.parse('2025-01-01T12:00:00Z') / 1000, location_lat: -1, location_lng: -1 },
    { slug: 'old', timestamp: Date.parse('2024-07-01T12:00:00Z') / 1000 },
  ];
  let app;
  let destroy;
  vm.runInNewContext(source, {
    HASHTAG_LIST: { fish: { name: '魚' }, jelly: { name: 'クラゲ' }, empty: { name: '空' } },
    ARCHIVES: { fish: posts, jelly: posts.slice(0, 1), empty: [] },
    window: win, document: doc, URLSearchParams,
    setTimeout: (fn) => fn(), L: { point: (x, y) => ({ x, y }) },
    Vue: function(options) {
      app = options.data;
      for (const [name, fn] of Object.entries(options.methods)) app[name] = fn.bind(app);
      for (const [name, fn] of Object.entries(options.computed)) Object.defineProperty(app, name, { get: fn.bind(app) });
      app.$nextTick = (fn) => fn();
      app.$refs = {
        photoList: list, brand: { getBoundingClientRect: () => ({ bottom: app.view.top + 70 }) },
        datasetTrigger: { focus() { focus.datasets++; }, getBoundingClientRect: () => ({ bottom: app.view.top + 68 }) },
        infoTrigger: { focus() { focus.info++; }, getBoundingClientRect: () => ({ bottom: app.view.top + 68 }) },
        datasetPicker: { contains: (target) => target === 'dataset', querySelector: () => ({ querySelector: () => null }) },
        infoMenu: { contains: (target) => target === 'info' },
        viewContainer: { getBoundingClientRect: () => ({ top: app.view.top, left: 180, width: win.innerWidth - 180 }) },
      };
      options.created.call(app);
      destroy = () => options.destroyed.call(app);
      return app;
    },
  });
  app.updateScreenSize();
  const capture = new Set();
  const handle = { setPointerCapture: (id) => capture.add(id), hasPointerCapture: (id) => capture.has(id), releasePointerCapture: (id) => capture.delete(id) };
  const pointer = (y, time = 0, id = 7) => ({ clientY: y, timeStamp: time, pointerId: id, isPrimary: true, button: 0, currentTarget: handle });
  return { app, elements, win, list, focus, pointer, frames, destroy,
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); },
  };
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

test('iPhoneのURLバーで隠れた領域を除き、CSSとシートで同じ表示領域を使う', () => {
  const { app } = viewer({ width: 430, height: 932, visualViewport: {
    width: 430, height: 690, offsetTop: 110, offsetLeft: 0, scale: 1,
  } });
  assert.equal(app.view.wh, 690);
  assert.equal(app.view.headerBottom, 82);
  assert.equal(app.viewerStyle['--viewport-height'], '690px');
  assert.equal(app.viewerStyle['--viewport-width'], '430px');
  assert.equal(app.viewerStyle['--viewport-top'], '110px');
  assert.equal(app.viewerStyle['--viewport-bottom-gap'], '132px');
  const attributionBaseline = app.viewerStyle['--initial-sheet-height'];
  for (const level of [0, 1, 2]) {
    app.setSheetLevel(level);
    assert.ok(app.sheetHeight <= 690 - app.view.headerBottom);
    assert.equal(app.viewerStyle['--initial-sheet-height'], attributionBaseline);
  }
});

test('URLバーの表示・非表示や表示領域の移動でも選択状態を保ち、ヘッダーの余白を累積しない', () => {
  const { app, win, pointer } = viewer({ width: 430, height: 932, visualViewport: {
    width: 430, height: 690, offsetTop: 110, scale: 1,
  } });
  app.setHashtag('fish');
  app.setPeriodYear(2025);
  app.startSheetDrag(pointer(600));
  win.visualViewport.offsetTop = 140;
  app.updateScreenSize();
  assert.equal(app.sheet.dragging, true);
  assert.equal(app.view.headerBottom, 82);
  assert.equal(app.view.bottomGap, 102);
  win.visualViewport.height = 780;
  win.visualViewport.offsetTop = 40;
  app.updateScreenSize();
  assert.equal(app.sheet.dragging, false);
  assert.equal(app.sheet.level, 1);
  assert.equal(app.view.wh, 780);
  assert.equal(app.view.headerBottom, 82);
  assert.equal(app.hashtag.selected, 'fish');
  assert.equal(app.displayCount, 2);
});

test('横向き・キーボード表示の狭い領域でもシートが画面からはみ出さない', () => {
  const { app, win } = viewer({ visualViewport: { width: 393, height: 700, scale: 1 } });
  app.setSheetLevel(2);
  win.innerWidth = 852;
  win.innerHeight = 393;
  Object.assign(win.visualViewport, { width: 852, height: 290, offsetTop: 30, offsetLeft: 0 });
  app.updateScreenSize();
  assert.equal(app.isMobile, true);
  assert.equal(app.viewerStyle['--viewport-width'], '852px');
  assert.equal(app.sheetHeight, 290 - app.view.headerBottom);
  for (const height of [220, 100, 60]) {
    win.visualViewport.height = height;
    app.updateScreenSize();
    assert.ok(app.sheetStops.every((stop) => stop >= 0 && stop <= Math.max(0, height - app.view.headerBottom)));
  }
});

test('VisualViewport未対応または一時的にサイズが0の時は従来の画面寸法へフォールバックする', () => {
  const { app, win } = viewer();
  assert.equal(app.viewerStyle['--viewport-height'], '852px');
  win.visualViewport = { height: 0, width: 0, offsetTop: 200, scale: 1 };
  app.updateScreenSize();
  assert.equal(app.viewerStyle['--viewport-width'], '393px');
  assert.equal(app.viewerStyle['--viewport-height'], '852px');
  assert.equal(app.view.top, 0);
});

test('ページのピンチズームでレイアウトを縮めたりPCとスマホを切り替えたりしない', () => {
  const { app, win } = viewer({ visualViewport: { width: 393, height: 700, scale: 1 } });
  Object.assign(win.visualViewport, { width: 196.5, height: 350, scale: 2, offsetTop: 150 });
  app.updateScreenSize();
  assert.equal(app.viewerStyle['--viewport-width'], '393px');
  assert.equal(app.viewerStyle['--viewport-height'], '700px');
  assert.equal(app.view.top, 0);
  assert.equal(app.isMobile, true);
  Object.assign(win.visualViewport, { width: 393, height: 740, scale: 1, offsetTop: 0 });
  app.updateScreenSize();
  assert.equal(app.view.wh, 740);
});

test('表示領域のresize・scroll・履歴復帰をフレーム単位でまとめ、破棄時に解除する', () => {
  const { app, win, frames, flushFrames, destroy } = viewer({ visualViewport: { width: 393, height: 700, scale: 1 } });
  app.showMap = () => {};
  app.loadPage();
  win.visualViewport.height = 650;
  win.visualViewport.dispatch('resize');
  win.visualViewport.dispatch('scroll');
  win.dispatch('resize');
  win.dispatch('pageshow');
  assert.equal(frames.size, 1);
  flushFrames();
  assert.equal(app.view.wh, 650);
  win.visualViewport.dispatch('scroll');
  assert.equal(frames.size, 1);
  destroy();
  assert.equal(frames.size, 0);
  for (const target of [win, win.visualViewport]) {
    assert.ok([...target.listeners.values()].every((listeners) => listeners.size === 0));
  }
});
