import { HASHTAG_LIST, ARCHIVES } from "../../data/archives.js"
import { ArchiveMap, isValidLocation } from "./archive-map.js?v=7.5"
var PHOTO_URL_BASE = 'https://data.cocolab.jp/repot-thumb/'
const DESKTOP_MIN_WIDTH = 1200;
const DIALOG_ACTIONS = {
  license: 'showLicenseDialog',
  about: 'showAboutDialog',
  developer: 'showDeveloperDialog',
  'period-setting': 'showPeriodSettingDialog',
};
const $ = (id) => { return document.getElementById(id); }
var app = new Vue({
  delimiters: ['${', '}'],
  el: '#app',
  data: {
    map: null,
    mapStatus: { loading: true, error: '' },
    hashtag: {
      list: HASHTAG_LIST,
      selected: null,
    },
    archives: ARCHIVES,
    selectedSlug: null,
    menus: { datasets: false, info: false },
    view: {
      wh: 0,
      ww: 0,
      viewportWidth: 0,
      top: 0,
      left: 0,
      bottomGap: 0,
      rightGap: 0,
      headerBottom: 96,
      divideRatio: 0.5,
      isDragging: false,
      dividerPointerId: null,
    },
    sheet: {
      level: 1,
      dragging: false,
      dragHeight: 0,
      startHeight: 0,
      startY: 0,
      startTime: 0,
      pointerId: null,
      moved: false,
      ignoreClick: false,
    },
    period: {
      from: new Date('2000-01-01'),
      to: new Date(),
    },
    periodError: '',
  },
  created: function() {
    this._viewportFrame = null;
  },
  mounted: function() {
    this.updateScreenSize();
    this.loadPage();
  },
  destroyed: function () {
    window.removeEventListener('resize', this.queueScreenUpdate);
    window.removeEventListener('pageshow', this.queueScreenUpdate);
    window.removeEventListener('hashchange', this.checkHash, false);
    window.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('pointerdown', this.onOutsidePointer);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.queueScreenUpdate);
      window.visualViewport.removeEventListener('scroll', this.queueScreenUpdate);
    }
    if (this._viewportFrame !== null) window.cancelAnimationFrame(this._viewportFrame);
    if (this.map) this.map.remove();
  },
  methods: {
    loadPage() {
      // SafariのURLバー・キーボード・画面回転・履歴からの復帰に追従する。
      window.addEventListener('resize', this.queueScreenUpdate);
      window.addEventListener('pageshow', this.queueScreenUpdate);
      window.addEventListener('hashchange', this.checkHash);
      window.addEventListener('keydown', this.onKeydown);
      document.addEventListener('pointerdown', this.onOutsidePointer);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this.queueScreenUpdate);
        window.visualViewport.addEventListener('scroll', this.queueScreenUpdate);
      }
      this.showMap();
      this.checkQueryStrings();
      this.checkHash();
    },
    checkQueryStrings() {
      const target = new URLSearchParams(window.location.search).get('h');
      if (!window.location.hash && target && Object.hasOwn(this.archives, target)) this.setHashtag(target);
    },
    getHash() {
      try { return decodeURIComponent(window.location.hash.slice(1)); }
      catch (_) { return null; }
    },
    checkHash() {
      const hash = this.getHash();
      if (hash === null) return;
      if (Object.hasOwn(DIALOG_ACTIONS, hash)) {
        this[DIALOG_ACTIONS[hash]](false);
        return;
      }
      this.closeDialogs();
      if (hash && Object.keys(this.archives).includes(hash) && this.map) {
        this.setHashtag(hash, false);
      }
    },
    replaceHash(hash) {
      window.history.replaceState(null, '', hash
        ? `#${encodeURIComponent(hash)}`
        : window.location.pathname + window.location.search);
    },
    queueScreenUpdate() {
      if (this._viewportFrame !== null) return;
      this._viewportFrame = window.requestAnimationFrame(() => {
        this._viewportFrame = null;
        this.updateScreenSize();
      });
    },
    updateScreenSize() {
      const viewport = window.visualViewport;
      // ページ自体のピンチズームではレイアウトを組み直さない。
      if (viewport && Math.abs((viewport.scale || 1) - 1) > 0.01 && this.view.wh) return;
      const hasViewport = viewport && viewport.height > 0 && viewport.width > 0;
      const height = hasViewport ? viewport.height : window.innerHeight;
      const width = hasViewport ? viewport.width : window.innerWidth;
      const top = hasViewport ? Math.max(0, viewport.offsetTop || 0) : 0;
      const left = hasViewport ? Math.max(0, viewport.offsetLeft || 0) : 0;
      const root = document.documentElement;
      const layoutHeight = (root && root.clientHeight) || window.innerHeight;
      const layoutWidth = (root && root.clientWidth) || window.innerWidth;
      if (height !== this.view.wh || width !== this.view.viewportWidth || window.innerWidth !== this.view.ww) {
        this.cancelSheetDrag();
        this.view.isDragging = false;
        this.view.dividerPointerId = null;
      }
      this.view.wh = height;
      this.view.ww = window.innerWidth;
      this.view.viewportWidth = width;
      this.view.top = top;
      this.view.left = left;
      this.view.bottomGap = Math.max(0, layoutHeight - top - height);
      this.view.rightGap = Math.max(0, layoutWidth - left - width);
      if (!this.isMobile) this.closeMenus();
      this.$nextTick(() => {
        this.view.headerBottom = this.isMobile ? Math.ceil(Math.max(
          this.$refs.brand.getBoundingClientRect().bottom,
          this.$refs.datasetTrigger.getBoundingClientRect().bottom,
          this.$refs.infoTrigger.getBoundingClientRect().bottom,
        ) - this.$refs.viewContainer.getBoundingClientRect().top) + 12 : 0;
        if (this.map) {
          this.map.resize();
        }
        this.updatePopupLayout();
        this.refreshLazyload();
      });
    },
    startDragDivider(e) {
      if (this.isMobile || e.isPrimary === false || e.button !== 0) return;
      this.view.isDragging = true;
      this.view.dividerPointerId = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onDragDivider(e) {
      if (!this.view.isDragging || e.pointerId !== this.view.dividerPointerId) return;
      const bounds = this.$refs.viewContainer.getBoundingClientRect();
      this.view.divideRatio = Math.max(0.2, Math.min(0.8, (e.clientX - bounds.left) / bounds.width));
    },
    stopDragDivider(e) {
      if (!this.view.isDragging || e.pointerId !== this.view.dividerPointerId) return;
      this.view.isDragging = false;
      this.view.dividerPointerId = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      this.resizeDivider(this.view.divideRatio);
    },
    resizeDivider(ratio) {
      this.view.divideRatio = Math.max(0.2, Math.min(0.8, ratio));
      this.$nextTick(() => {
        if (this.map) this.map.resize();
        this.updatePopupLayout();
      });
    },
    toggleDatasetMenu() {
      if (this.menus.datasets) this.closeMenus();
      else this.openDatasetMenu();
    },
    openDatasetMenu() {
      this.menus.info = false;
      this.menus.datasets = true;
      this.$nextTick(() => {
        const options = this.$refs.datasetPicker.querySelector('#dataset-options');
        const current = options.querySelector('[aria-current="true"]') || options.querySelector('button');
        if (current) current.focus({ preventScroll: true });
      });
    },
    toggleInfoMenu() {
      this.menus.datasets = false;
      this.menus.info = !this.menus.info;
    },
    closeMenus() {
      this.menus.datasets = false;
      this.menus.info = false;
    },
    onOutsidePointer(e) {
      if (!this.$refs.datasetPicker.contains(e.target)) this.menus.datasets = false;
      if (!this.$refs.infoMenu.contains(e.target)) this.menus.info = false;
    },
    onKeydown(e) {
      if (e.key !== 'Escape' || (!this.menus.datasets && !this.menus.info)) return;
      const trigger = this.menus.datasets ? this.$refs.datasetTrigger : this.$refs.infoTrigger;
      this.closeMenus();
      trigger.focus({ preventScroll: true });
      e.preventDefault();
    },
    setSheetLevel(level) {
      this.sheet.level = Math.max(0, Math.min(2, level));
      this.$nextTick(() => this.updatePopupLayout());
      this.refreshLazyload();
    },
    changeSheetLevel(delta) {
      this.setSheetLevel(this.sheet.level + delta);
    },
    toggleSheet(e) {
      if (this.sheet.ignoreClick && e && e.detail !== 0) {
        this.sheet.ignoreClick = false;
        return;
      }
      this.sheet.ignoreClick = false;
      this.setSheetLevel((this.sheet.level + 1) % 3);
    },
    startSheetDrag(e) {
      if (!this.isMobile || e.isPrimary === false || (e.button !== undefined && e.button !== 0) || this.sheet.dragging) return;
      this.sheet.startHeight = this.sheetHeight;
      this.sheet.dragHeight = this.sheetHeight;
      this.sheet.startY = e.clientY;
      this.sheet.startTime = e.timeStamp;
      this.sheet.pointerId = e.pointerId;
      this.sheet.moved = false;
      this.sheet.dragging = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    moveSheetDrag(e) {
      if (!this.sheet.dragging || e.pointerId !== this.sheet.pointerId) return;
      const delta = this.sheet.startY - e.clientY;
      if (Math.abs(delta) > 5) this.sheet.moved = true;
      this.sheet.dragHeight = Math.max(this.sheetStops[0], Math.min(this.sheetStops[2], this.sheet.startHeight + delta));
    },
    endSheetDrag(e) {
      if (!this.sheet.dragging || e.pointerId !== this.sheet.pointerId) return;
      this.moveSheetDrag(e);
      let level = this.sheetStops.reduce((best, height, index, stops) =>
        Math.abs(height - this.sheet.dragHeight) < Math.abs(stops[best] - this.sheet.dragHeight) ? index : best, 0);
      const delta = this.sheet.startY - e.clientY;
      if (level === this.sheet.level && Math.abs(delta) > 36 && e.timeStamp - this.sheet.startTime < 300) {
        level += Math.sign(delta);
      }
      this.sheet.ignoreClick = this.sheet.moved;
      this.sheet.dragging = false;
      this.sheet.pointerId = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      this.setSheetLevel(level);
    },
    cancelSheetDrag() {
      if (!this.sheet.dragging) return;
      this.sheet.dragging = false;
      this.sheet.pointerId = null;
      this.sheet.ignoreClick = false;
    },
    updatePopupLayout() {
      if (!this.map) return;
      this.map.setViewport({
        top: this.isMobile ? this.view.headerBottom : 16,
        bottom: this.isMobile ? this.sheetHeight + 16 : 16,
      });
    },
    closeDialogs(exceptId = null) {
      for (const id of Object.keys(DIALOG_ACTIONS)) {
        if (id !== exceptId && $(id).open) $(id).close();
      }
    },
    showDialog(id, updateHash = true) {
      this.closeMenus();
      if (updateHash) this.replaceHash(id);
      this.closeDialogs(id);
      if (!$(id).open) $(id).showModal();
    },
    dismissDialog(id) {
      if ($(id).open) $(id).close();
      this.onDialogClose(id);
    },
    onDialogClose(id) {
      // Escで閉じた場合もURLを戻す。別の画面へ移動した後のcloseイベントは無視する。
      if (!$(id).open && this.getHash() === id) this.replaceHash(this.hashtag.selected || '');
    },
    showLicenseDialog(updateHash = true) {
      this.showDialog('license', updateHash);
    },
    dismissLicenseDialog() {
      this.dismissDialog('license');
    },
    showAboutDialog(updateHash = true) {
      this.showDialog('about', updateHash);
    },
    dismissAboutDialog() {
      this.dismissDialog('about');
    },
    showDeveloperDialog(updateHash = true) {
      this.showDialog('developer', updateHash);
    },
    dismissDeveloperDialog() {
      this.dismissDialog('developer');
    },
    showPeriodSettingDialog(updateHash = true) {
      this.periodError = '';
      $("form-period-from").value = this.getDateInputValue(this.period.from);
      $("form-period-to").value = this.getDateInputValue(this.period.to);
      this.showDialog('period-setting', updateHash);
    },
    dismissPeriodSettingDialog() {
      this.dismissDialog('period-setting');
    },
    refreshLazyload() {
      this.$nextTick(() => {
        setTimeout(() => {
          if (typeof lazyload === 'function') {
            lazyload();
          }
        }, 0);
      });
    },
    setPeriod() {
      const from = new Date($("form-period-from").value + "T00:00:00");
      const to = new Date($("form-period-to").value + "T23:59:59.999");
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
        this.periodError = '開始日と終了日を確認してください。終了日は開始日以降にしてください。';
        return;
      }
      this.periodError = '';
      this.period.from = from;
      this.period.to = to;
      this.selectedSlug = null;
      if(this.hashtag.selected != null && this.map != null) {
        this.putMarkers();
      }
      this.dismissPeriodSettingDialog();
      this.refreshLazyload();
    },
    setPeriodYear(year) {
      $("form-period-from").value = `${year}-01-01`;
      $("form-period-to").value = `${year}-12-31`;
      this.setPeriod();
    },
    setPeriodAll() {
      if(this.hashtag.selected == null || !this.archives[this.hashtag.selected] || this.archives[this.hashtag.selected].length === 0) {
        return;
      }
      let tgtArchive = this.archives[this.hashtag.selected];
      let first = new Date(tgtArchive[tgtArchive.length - 1].timestamp * 1000);
      let last = new Date(tgtArchive[0].timestamp * 1000);
      $("form-period-from").value = this.getDateInputValue(first);
      $("form-period-to").value = this.getDateInputValue(last);
      this.setPeriod();
    },
    checkPeriod(timestamp) {
      let dt = new Date(timestamp * 1000);
      return (dt >= this.period.from && dt <= this.period.to);
    },
    showMap() {
      try {
        this.map = Object.preventExtensions(new ArchiveMap('map', {
          onSelect: (slug) => {
            if (this.isMobile && this.sheet.level === 2) this.setSheetLevel(1);
            this.showInList(slug);
          },
          onPopupOpen: () => {
            if (this.isMobile && this.sheet.level === 2) this.setSheetLevel(1);
            this.$nextTick(() => this.updatePopupLayout());
          },
          onStatus: (status) => { this.mapStatus = status; },
        }));
        this.updatePopupLayout();
      } catch (error) {
        this.mapStatus = { loading: false, error: '地図を表示できませんでした。ページを再読み込みするか、WebGL対応のブラウザーでお試しください。' };
        console.warn('Map initialization:', error);
      }
    },
    retryMap() {
      if (this.map) this.map.reload();
      else {
        this.showMap();
        if (this.map && this.hashtag.selected) this.putMarkers();
      }
    },
    setHashtag(hashtag, updateHash = true) {
      if (!Object.keys(this.archives).includes(hashtag)) {
        return;
      }
      if (updateHash) {
        this.replaceHash(hashtag);
      }
      const refocus = this.menus.datasets;
      this.closeMenus();
      this.period.from = new Date("2000-01-01");
      this.period.to = new Date();
      this.selectedSlug = null;
      this.hashtag.selected = hashtag;
      if (this.map) this.putMarkers();
      this.refreshLazyload();
      this.$nextTick(() => {
        if (this.$refs.photoList) this.$refs.photoList.scrollTop = 0;
        if (refocus) this.$refs.datasetTrigger.focus({ preventScroll: true });
        if (this.map) {
          this.map.resize();
        }
      });
    },
    validateLocation(repot) {
      return isValidLocation(repot);
    },
    putMarkers() {
      this.map.setPosts(this.filteredArchives, this.hashtag.list[this.hashtag.selected], (post) => this.getPhotoURL(post));
    },
    showInMap(repotSlug) {
      this.selectedSlug = repotSlug;
      if (this.map && this.map.hasPost(repotSlug)) {
        if (this.isMobile && this.sheet.level === 2) this.setSheetLevel(1);
        this.updatePopupLayout();
        this.map.focusPost(repotSlug, { animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches });
        this.showInList(repotSlug);
      }
    },
    showInList(repotSlug) {
      this.selectedSlug = repotSlug;
      this.$nextTick(() => {
        const card = $("list-" + repotSlug);
        const list = this.$refs.photoList;
        if (!card || !list) return;
        const top = card.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 8;
        list.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      });
    },
    getDatetimeStr(timestamp) {
      let dt = new Date(timestamp * 1000);
      return dt.getFullYear() + "/"
           + ("0" + (dt.getMonth()+1)).slice(-2) + "/"
           + ("0" + dt.getDate()).slice(-2)  + " "
           + ("0" + dt.getHours()).slice(-2) + ":"
           + ("0" + dt.getMinutes()).slice(-2);
    },
    getDateStr(dt) {
      return dt.getFullYear() + "/"
           + ("0" + (dt.getMonth()+1)).slice(-2) + "/"
           + ("0" + dt.getDate()).slice(-2);
    },
    getDateInputValue(dt) {
      return dt.getFullYear() + "-"
           + ("0" + (dt.getMonth()+1)).slice(-2) + "-"
           + ("0" + dt.getDate()).slice(-2);
    },
    getPhotoURL(repot) {
      return PHOTO_URL_BASE + repot.filename
    },
  },
  computed: {
    viewerStyle: function() {
      const style = {
        '--sheet-height': (this.isMobile ? this.sheetHeight : 0) + 'px',
        '--header-bottom': this.view.headerBottom + 'px',
        '--viewport-top': this.view.top + 'px',
        '--viewport-left': this.view.left + 'px',
        '--viewport-bottom-gap': this.view.bottomGap + 'px',
        '--viewport-right-gap': this.view.rightGap + 'px',
      };
      if (this.view.wh) style['--viewport-height'] = this.view.wh + 'px';
      if (this.view.viewportWidth) style['--viewport-width'] = this.view.viewportWidth + 'px';
      return style;
    },
    isMobile: function() { return this.view.ww < DESKTOP_MIN_WIDTH; },
    mapWidth: function() { return (this.view.divideRatio * 100) + '%'; },
    listWidth: function() { return ((1 - this.view.divideRatio) * 100) + '%'; },
    selectedDatasetName: function() {
      return this.hashtag.selected == null ? 'データセットを選択' : this.hashtag.list[this.hashtag.selected].name;
    },
    sheetStops: function() {
      const height = this.view.wh || window.innerHeight;
      const maximum = Math.max(0, height - this.view.headerBottom);
      const minimum = Math.min(176, maximum);
      const middle = Math.min(maximum, Math.max(minimum + 24, Math.round(height * 0.44)));
      return [minimum, middle, maximum];
    },
    sheetHeight: function() {
      return this.sheet.dragging ? this.sheet.dragHeight : this.sheetStops[this.sheet.level];
    },
    filteredArchives: function() {
      return (this.archives[this.hashtag.selected] || []).filter((repot) => this.checkPeriod(repot.timestamp));
    },
    displayCount: function() {
      if(this.hashtag.selected == null || !this.archives[this.hashtag.selected]) {
        return 0;
      }
      return this.filteredArchives.length;
    },
    periodYears: function() {
      if(this.hashtag.selected == null || !this.archives[this.hashtag.selected]) {
        return [];
      }
      let years = new Set();
      this.archives[this.hashtag.selected].forEach((repot) => {
        years.add(new Date(repot.timestamp * 1000).getFullYear());
      });
      return Array.from(years).sort((a, b) => b - a);
    },
    displayFrom: function() {
      const archive = this.archives[this.hashtag.selected];
      if (!archive || !archive.length) return '—';
      let dt = new Date(archive[archive.length - 1].timestamp * 1000);
      dt = (dt < this.period.from) ? this.period.from : dt;
      return this.getDateStr(dt);
    },
    displayTo: function() {
      const archive = this.archives[this.hashtag.selected];
      if (!archive || !archive.length) return '—';
      let dt = new Date(archive[0].timestamp * 1000);
      dt = (dt > this.period.to) ? this.period.to : dt;
      return this.getDateStr(dt);
    }

  }
});
