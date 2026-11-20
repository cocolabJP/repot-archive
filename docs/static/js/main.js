import { HASHTAG_LIST, ARCHIVES } from "../../data/archives.js"
var PHOTO_URL_BASE = 'https://repot-archive.yukimat.jp/thumb/'
const DESKTOP_MIN_WIDTH = 1200;
const $ = (id) => { return document.getElementById(id); }
var app = new Vue({
  delimiters: ['${', '}'],
  el: '#app',
  data: {
    map: null,
    layer: null,
    markers: {},
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
      from: -1,
      to: -1,
    },
    periodError: '',
  },
  created: function() {
    this._openPopup = null;
  },
  mounted: function() {
    this.updateScreenSize();
    this.loadPage();
  },
  destroyed: function () {
    window.removeEventListener('resize', this.updateScreenSize, false);
    window.removeEventListener('hashchange', this.checkHash, false);
    window.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('pointerdown', this.onOutsidePointer);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this.updateScreenSize);
    if (this.map) this.map.remove();
  },
  methods: {
    loadPage() {
      // 画面の向き変更イベントを登録
      window.addEventListener('resize', this.updateScreenSize);
      window.addEventListener('hashchange', this.checkHash);
      window.addEventListener('keydown', this.onKeydown);
      document.addEventListener('pointerdown', this.onOutsidePointer);
      if (window.visualViewport) window.visualViewport.addEventListener('resize', this.updateScreenSize);
      this.showMap();
      this.checkQueryStrings();
      this.checkHash();
    },
    checkQueryStrings() {
      const target = new URLSearchParams(window.location.search).get('h');
      if (!window.location.hash && target && Object.hasOwn(this.archives, target)) this.setHashtag(target);
    },
    checkHash() {
      let hash;
      try { hash = decodeURIComponent(window.location.hash.slice(1)); }
      catch (_) { return; }
      if (hash === 'license') {
        this.showLicenseDialog(false);
        return;
      }
      if ($('license').open) {
        this.dismissLicenseDialog();
      }
      if (hash && Object.keys(this.archives).includes(hash) && this.map) {
        this.setHashtag(hash, false);
      }
    },
    replaceHash(hash) {
      window.history.replaceState(null, '', `#${encodeURIComponent(hash)}`);
    },
    updateScreenSize() {
      this.cancelSheetDrag();
      this.view.isDragging = false;
      this.view.dividerPointerId = null;
      this.view.wh = window.innerHeight;
      this.view.ww = window.innerWidth;
      if (!this.isMobile) this.closeMenus();
      this.$nextTick(() => {
        this.view.headerBottom = this.isMobile ? Math.ceil(Math.max(
          this.$refs.brand.getBoundingClientRect().bottom,
          this.$refs.datasetTrigger.getBoundingClientRect().bottom,
        )) + 12 : 0;
        if (this.map) {
          this.map.invalidateSize();
          if (this.map.attributionControl) this.map.attributionControl.setPosition(this.isMobile ? 'bottomleft' : 'bottomright');
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
        if (this.map) this.map.invalidateSize();
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
    updatePopupLayout(popup = this._openPopup) {
      if (!popup || !popup.isOpen()) return;
      const top = this.isMobile ? this.view.headerBottom : 16;
      const bottom = this.isMobile ? this.sheetHeight + 16 : 16;
      const height = this.isMobile ? this.view.wh : this.map.getSize().y;
      popup.options.autoPanPaddingTopLeft = L.point(16, top);
      popup.options.autoPanPaddingBottomRight = L.point(16, bottom);
      popup.options.maxHeight = Math.max(80, height - top - bottom - 32);
      popup.update();
    },
    showLicenseDialog(updateHash = true) {
      this.closeMenus();
      if (updateHash) {
        this.replaceHash('license');
      }
      if (!$("license").open) {
        $("license").showModal();
      }
    },
    dismissLicenseDialog() {
      $("license").close();
    },
    showAboutDialog() {
      this.closeMenus();
      if (!$("about").open) $("about").showModal();
    },
    dismissAboutDialog() {
      $("about").close();
    },
    showPeriodSettingDialog() {
      this.closeMenus();
      this.periodError = '';
      $("form-period-from").value = this.getDateInputValue(this.period.from);
      $("form-period-to").value = this.getDateInputValue(this.period.to);
      $("period-setting").showModal();
    },
    dismissPeriodSettingDialog() {
      $("period-setting").close();
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
      this.map = L.map('map', {
        center: [34.66658501665325, 133.91804081661178],
        zoom: 12,
        zoomControl: true,
        minZoom: 0,
        maxZoom: 18,
        dragging: true,
        scrollWheelZoom: 'center',
        doubleClickZoom: 'center',
        touchZoom: 'center',
      });
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors, <a href="https://repot-archive.cocolab.jp/#license">repot</a> contributors, <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
        maxZoom: 19,
      }).addTo(this.map);
      this.map.on('popupopen', ({ popup }) => {
        this._openPopup = popup;
        if (this.isMobile && this.sheet.level === 2) this.setSheetLevel(1);
        this.$nextTick(() => this.updatePopupLayout(popup));
        this.refreshLazyload();
      });
      this.map.on('popupclose', () => { this._openPopup = null; });
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
          this.map.invalidateSize();
        }
      });
    },
    validateLocation(repot) {
      return Math.abs(repot.location_lat) > 1 || Math.abs(repot.location_lng) > 1;
    },
    putMarkers() {
      if(this.layer != null) {
        this.map.removeLayer(this.layer);
      }
      let tgtArchive = this.archives[this.hashtag.selected];
      this.layer = L.layerGroup();
      this.markers = {};
      for(let i=0; i<tgtArchive.length; i++) {
        let tgtHashtag = this.hashtag.list[this.hashtag.selected];
        if(this.validateLocation(tgtArchive[i]) && this.checkPeriod(tgtArchive[i].timestamp)) {
          // 位置情報が欠損している場合はスキップ
          let m = L.marker([tgtArchive[i].location_lat, tgtArchive[i].location_lng], {
                    icon: L.icon({
                        iconUrl: 'static/img/icon/' + tgtHashtag.icon.name + '.svg',
                        iconSize: tgtHashtag.icon.size,
                        iconAnchor: tgtHashtag.icon.anchor,
                    }),
                    repotSlug: tgtArchive[i].slug,
                  }).bindPopup(L.popup({
                    autoPanPaddingTopLeft: L.point(16, this.isMobile ? this.view.headerBottom : 16),
                    autoPanPaddingBottomRight: L.point(16, this.isMobile ? this.sheetHeight + 16 : 16),
                    'content': '<img class="lazyload" src="static/img/loading-photo.png" data-src="' + this.getPhotoURL(tgtArchive[i]) + '">'
                                + ((tgtArchive[i].caption) != null ? '<p>' + tgtArchive[i].caption + '</p>' : '')
                                + '<ul>'
                                    + '<li>' + tgtHashtag.name + '</li>'
                                    + ((tgtArchive[i].hashtag_names.length > 0) ? '<li>' + tgtArchive[i].hashtag_names.join('</li><li>') + '</li>' : '')
                                + '</ul>',
                    'offset': tgtHashtag.icon.popup,
                  })).on('click', (e) => {
                    this.showInList(e.target.options.repotSlug);
                  });
          this.markers[tgtArchive[i].slug] = m;
          this.layer.addLayer(m);
        }
      }
      this.map.addLayer(this.layer)
    },
    showInMap(repotSlug) {
      this.selectedSlug = repotSlug;
      if(repotSlug in this.markers) {
        if (this.isMobile && this.sheet.level === 2) this.setSheetLevel(1);
        const marker = this.markers[repotSlug];
        const position = marker.getLatLng();
        const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (animate && !this.map.getCenter().equals(position)) {
          this.map.once('moveend', () => {
            if (this.selectedSlug === repotSlug) marker.openPopup();
          });
        }
        this.map.flyTo(position, this.map.getZoom(), {
          animate,
          duration: 1.5
        });
        if (!animate || this.map.getCenter().equals(position)) marker.openPopup();
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
    isMobile: function() { return this.view.ww < DESKTOP_MIN_WIDTH; },
    mapWidth: function() { return (this.view.divideRatio * 100) + '%'; },
    listWidth: function() { return ((1 - this.view.divideRatio) * 100) + '%'; },
    selectedDatasetName: function() {
      return this.hashtag.selected == null ? 'データセットを選択' : this.hashtag.list[this.hashtag.selected].name;
    },
    sheetStops: function() {
      const height = this.view.wh || window.innerHeight;
      const maximum = Math.max(80, height - this.view.headerBottom);
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
