import { HASHTAG_LIST, ARCHIVES } from "../../data/archives.js"
var PHOTO_URL_BASE = 'https://repot-archive.yukimat.jp/photo/'
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
    view: {
      wh: 0,
      ww: 0,
      mode: 'both',
      selected: 'map',
      divideRatio: 0.5,
      isDragging: false,
    },
  },
  created: function() {
  },
  mounted: function() {
    this.updateScreenSize();
    this.loadPage();
  },
  destroyed: function () {
    window.removeEventListener('resize', this.updateScreenSize(), false);
  },
  methods: {
    loadPage() {
      // 画面の向き変更イベントを登録
      window.addEventListener('resize', this.updateScreenSize);
      this.showMap();
    },
    updateScreenSize() {
      this.view.wh = window.innerHeight;
      this.view.ww = window.innerWidth;
      this.view.mode = (this.view.ww < 1200) ? "single" : "both";
      if(this.map) { this.map.invalidateSize(); }
    },
    startDragDivider(e) {
      this.view.isDragging = true;
    },
    onDragDivider(e) {
      if(this.view.isDragging) {
        let r = (e.pageX - 180) / (this.view.ww - 180);
        this.view.divideRatio = Math.max(0.2, Math.min(r, 0.8));
      }
    },
    stopDragDivider(e) {
      this.view.isDragging = false;
      if(this.map) { this.map.invalidateSize(); }
    },
    showLicenseDialog() {
      $("license").showModal();
    },
    dismissLicenseDialog() {
      $("license").close();
    },
    showAboutDialog() {
      $("about").showModal();
    },
    dismissAboutDialog() {
      $("about").close();
    },
    showMap() {
      setTimeout(() => {
        this.map = L.map('map', {
          center: [34.73177572534839, 135.73429797376784],
          zoom: 10,
          zoomControl: true,
          minZoom: 0,
          maxZoom: 18,
          dragging: true,
          scrollWheelZoom: 'center',
          doubleClickZoom: 'center',
          touchZoom:       'center',
        });
        L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors, <a href="https://repot-archive.cocolab.jp/">repot</a> contributors, <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
          maxZoom: 19,
        }).addTo(this.map);
        this.map.on('popupopen', function(e) {
          lazyload();
        });
      }, 500);
    },
    setHashtag(hashtag) {
      this.hashtag.selected = hashtag;
      this.putMarkers();
      setTimeout(() => lazyload(), 500);
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
        let m = L.marker([tgtArchive[i].location_lat, tgtArchive[i].location_lng], {
                  icon: L.icon({
                      iconUrl: 'static/img/icon/' + tgtHashtag.icon.name + '.svg',
                      iconSize: tgtHashtag.icon.size,
                      iconAnchor: tgtHashtag.icon.anchor,
                  }),
                  repotSlug: tgtArchive[i].slug,
                }).bindPopup(L.popup({
                  'content': '<img class="lazyload" src="static/img/loading-photo.png" data-src="' + this.getPhotoURL(tgtArchive[i]) + '">',
                  'offset': tgtHashtag.icon.popup,
                })).on('click', (e) => {
                  this.showInList(e.target.options.repotSlug);
                });
        this.markers[tgtArchive[i].slug] = m;
        this.layer.addLayer(m);
      }
      this.map.addLayer(this.layer)
    },
    showInMap(repotSlug) {
      this.map.flyTo([this.markers[repotSlug].getLatLng().lat, this.markers[repotSlug].getLatLng().lng], this.map.getZoom(), {
        animate: true,
        duration: 1.5
      });
      this.markers[repotSlug].fire('click');
    },
    showInList(repotSlug) {
      let y = $("list-" + repotSlug).offsetTop;
      $("list").scrollTo({top: y-70, behavior: 'smooth'});
    },
    getDatetimeStr(timestamp) {
      let dt = new Date(timestamp * 1000);
      return dt.getFullYear() + "/"
           + ("0" + (dt.getMonth()+1)).slice(-2) + "/"
           + ("0" + dt.getDate()).slice(-2)  + " "
           + ("0" + dt.getHours()).slice(-2) + ":"
           + ("0" + dt.getMinutes()).slice(-2);
    },
    getDateStr(timestamp) {
      let dt = new Date(timestamp * 1000);
      return dt.getFullYear() + "/"
           + ("0" + (dt.getMonth()+1)).slice(-2) + "/"
           + ("0" + dt.getDate()).slice(-2);
    },
    getPhotoURL(repot) {
      return PHOTO_URL_BASE + repot.filename
    }
  },
  computed: {
    isBothMode:  function() { return this.view.mode == 'both'; },
    isMapMode:   function() { return this.isBothMode || this.view.selected == 'map';  },
    isListMode:  function() { return this.isBothMode || this.view.selected == 'list'; },
    mapWidth:    function() { return this.isBothMode ? ((this.view.ww - 180) * this.view.divideRatio) + 'px' : '100%'; },
    listWidth:   function() { return this.isBothMode ? ((this.view.ww - 180) * (1 - this.view.divideRatio)) + 'px' : '100%'; },
    displayFrom: function() {
      return this.getDateStr(this.archives[this.hashtag.selected][0].timestamp);
    },
    displayTo: function() {
      return this.getDateStr(this.archives[this.hashtag.selected][this.archives[this.hashtag.selected].length - 1].timestamp);
    }

  }
});