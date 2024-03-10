var PHOTO_URL_BASE = 'https://dxclhyyx7t596.cloudfront.net/uploads/'
var THUMB_URL_BASE = 'https://d1743dg9i7p6y2.cloudfront.net/photos/';
var HASHTAG_LIST = {
  479: {'name': '桜咲', 'icon': {'name': 'sakura', 'size': [40, 40], 'anchor': [20, 20], 'popup': [0, 0]}},
  702: {'name': 'pxky', 'icon': {'name': 'default', 'size': [40, 50], 'anchor': [20, 50], 'popup': [0, -25]}},
  685: {'name': '中四国魚', 'icon': {'name': 'default', 'size': [40, 50], 'anchor': [20, 50], 'popup': [0, -25]}},
  686: {'name': '釣った場所', 'icon': {'name': 'default', 'size': [40, 50], 'anchor': [20, 50], 'popup': [0, -25]}},
};
var app = new Vue({
  delimiters: ['${', '}'],
  el: '#app',
  data: {
    map: null,
    layer: null,
    hashtag: {
      list: HASHTAG_LIST,
      target: 0,
    },
    archives: archives,
  },
  created: function() {
  },
  mounted: function() {
  },
  destroyed: function () {
  },
  methods: {
    initMap() {
      setTimeout(() => {
        this.map = L.map('map', {
          center: [34.73177572534839, 135.73429797376784],
          zoom: 10,
          zoomControl: true,
          minZoom: 0,
          maxZoom: 19,
          dragging: true,
          scrollWheelZoom: 'center',
          doubleClickZoom: 'center',
          touchZoom:       'center',
        });
        L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
            attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
            maxZoom: 19,
        }).addTo(this.map);
        this.map.on('popupopen', function(e) {
          console.log("lazyload");
          lazyload();
        });
      }, 500);
    },
    setHashtag(hashtag) {
      this.hashtag.selected = hashtag;
      this.putMarkers();
    },
    putMarkers() {
      if(this.layer != null) {
        this.map.removeLayer(this.layer);
      }
      let tgtArchive = this.archives[this.hashtag.selected];
      this.layer = L.layerGroup();
      for(let i=0; i<tgtArchive.length; i++) {
        let tgtHashtag = this.hashtag.list[this.hashtag.selected];
        console.log(tgtArchive[i]);
        this.layer.addLayer(
          L.marker([tgtArchive[i].location_lat, tgtArchive[i].location_lng], {
            icon: L.icon({
                iconUrl: 'static/img/icon/' + tgtHashtag.icon.name + '.svg',
                iconSize: tgtHashtag.icon.size,
                iconAnchor: tgtHashtag.icon.anchor,
            })
          }).bindPopup(L.popup({
            'content': '<img class="lazyload" src="static/img/loading-photo.png" data-src="' + THUMB_URL_BASE + tgtArchive[i].filename + '">',
            'offset': tgtHashtag.icon.popup,
          }))
        );
      }
      this.map.addLayer(this.layer)
    },
  },
  computed: {
  }
});
app.initMap();