import { MAP_CONFIG } from './map-config.js?v=6.6';
import { registerHybridBasemap } from './hybrid-basemap.js?v=6.5';

const POST_SOURCE = 'repot-posts';
const POST_LAYER = 'repot-markers';
const protocols = new WeakMap();

export function isValidLocation(post) {
  const lat = post.location_lat;
  const lon = post.location_lng;
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180
    && !(lat === -1 && lon === -1) && !(lat === 0 && lon === 0);
}

export function prepareMapStyle(style, config = MAP_CONFIG) {
  if (style.version !== 8 || !Array.isArray(style.layers) || !style.sources) throw new Error('地図スタイルの形式が不正です。');
  const resolve = (url) => new URL(url, config.styleURL).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  let pmtilesSources = 0;
  const sources = Object.fromEntries(Object.entries(style.sources).map(([id, source]) => {
    const copy = { ...source };
    if (source.type === 'vector' && source.url?.startsWith('pmtiles://')) {
      // 配布用スタイル内の日付付きファイル名・相対パスを、自前の配信先に置き換える。
      copy.url = config.hybridURL || `pmtiles://${config.pmtilesURL}`;
      if (config.hybridURL && config.worldAttribution) copy.attribution = `${source.attribution || ''} | ${config.worldAttribution}`;
      pmtilesSources++;
    } else if (source.url) copy.url = resolve(source.url);
    if (source.tiles) copy.tiles = source.tiles.map(resolve);
    return [id, copy];
  }));
  if (!pmtilesSources) throw new Error('スタイルにPMTilesのベクトルソースがありません。');
  return { ...style, sources,
    ...(style.glyphs ? { glyphs: resolve(style.glyphs) } : {}),
    ...(style.sprite ? { sprite: typeof style.sprite === 'string' ? resolve(style.sprite)
      : style.sprite.map((sprite) => ({ ...sprite, url: resolve(sprite.url) })) } : {}),
  };
}

async function loadIcon(icon) {
  const image = new Image();
  image.src = `static/img/icon/${icon.name}.svg`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = icon.size[0] * 2;
  canvas.height = icon.size[1] * 2;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

// Vueの画面・期間選択と、MapLibreの非同期描画を分離する。
export class ArchiveMap {
  constructor(container, { config = MAP_CONFIG, library = maplibregl, pmtilesLibrary = pmtiles,
    fetcher = fetch, iconLoader = loadIcon, onSelect = () => {}, onPopupOpen = () => {}, onStatus = () => {} } = {}) {
    this.config = config;
    this.library = library;
    this.hybrid = config.worldTileJSONURL ? registerHybridBasemap(library, pmtilesLibrary, config, fetcher) : null;
    // ブラウザのfetchを、コントローラーをthisにしたメソッドとして呼ばない。
    this.fetcher = (url, options) => fetcher(url, options);
    this.iconLoader = iconLoader;
    this.onSelect = onSelect;
    this.onPopupOpen = onPopupOpen;
    this.onStatus = onStatus;
    this.posts = new Map();
    this.dataset = null;
    this.photoURL = null;
    this.popup = null;
    this.padding = { top: 16, bottom: 16, left: 16, right: 16 };
    this.iconCache = new Map();
    this.renderVersion = 0;
    this.styleVersion = 0;
    this.styleLoaded = false;
    this.focusVersion = 0;
    this.loadVersion = 0;
    this.styleAbort = null;
    this.removed = false;
    this.mapError = false;
    if (!protocols.has(library)) {
      const protocol = new pmtilesLibrary.Protocol();
      library.addProtocol('pmtiles', protocol.tile);
      protocols.set(library, protocol);
    }
    this.map = new library.Map({
      container, style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8eeeb' } }] },
      center: config.center, zoom: config.zoom, minZoom: config.minZoom, maxZoom: config.maxZoom,
      attributionControl: false, dragRotate: false, touchPitch: false, pitchWithRotate: false,
      scrollZoom: { around: 'center' }, touchZoomRotate: { around: 'center' },
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.addControl(new library.NavigationControl({ showCompass: false }), 'top-left');
    this.map.on('style.load', () => { this.styleLoaded = true; this.styleVersion++; this.renderPosts(); });
    this.map.on('click', (event) => {
      if (!this.map.getLayer(POST_LAYER)) return;
      const feature = this.map.queryRenderedFeatures(event.point, { layers: [POST_LAYER] })[0];
      if (feature && this.posts.has(feature.properties.slug)) {
        const slug = feature.properties.slug;
        this.onSelect(slug);
        this.openPopup(slug);
      }
    });
    this.map.on('mouseenter', POST_LAYER, () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', POST_LAYER, () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('error', (event) => {
      if (this.removed) return;
      this.mapError = true;
      this.onStatus({ loading: false, error: '地図データを読み込めません。接続を確認して再試行してください。' });
      console.warn('MapLibre:', event.error);
    });
    this.ready = this.reload();
  }

  async reload() {
    const version = ++this.loadVersion;
    this.hybrid?.reset();
    this.styleAbort?.abort();
    const abort = new AbortController();
    this.styleAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 20000);
    this.mapError = false;
    this.onStatus({ loading: true, error: '' });
    try {
      const response = await this.fetcher(this.config.styleURL, { signal: abort.signal });
      if (!response.ok) throw new Error(`地図スタイル: HTTP ${response.status}`);
      const style = prepareMapStyle(await response.json(), { ...this.config, hybridURL: this.hybrid?.url });
      if (this.removed || version !== this.loadVersion) return;
      this.styleLoaded = false;
      this.map.setStyle(style);
      this.map.once('idle', () => {
        if (!this.removed && version === this.loadVersion && !this.mapError) this.onStatus({ loading: false, error: '' });
      });
    } catch (error) {
      if (this.removed || version !== this.loadVersion) return;
      this.onStatus({ loading: false, error: '地図データを読み込めません。接続を確認して再試行してください。' });
      console.warn('Basemap:', error);
    } finally { clearTimeout(timeout); }
  }

  setPosts(posts, dataset, photoURL) {
    this.focusVersion++;
    this.popup?.remove();
    this.posts = new Map(posts.filter(isValidLocation).map((post) => [post.slug, post]));
    this.dataset = dataset;
    this.photoURL = photoURL;
    // 古いデータセットの地点を、アイコンの読込中にも表示し続けない。
    this.map.getSource(POST_SOURCE)?.setData({ type: 'FeatureCollection', features: [] });
    this.renderPosts();
  }

  async renderPosts() {
    const version = ++this.renderVersion;
    const styleVersion = this.styleVersion;
    if (!this.dataset || !this.styleLoaded) return;
    const icon = this.dataset.icon;
    const iconId = `repot-${icon.name}-${icon.size.join('x')}`;
    try {
      if (!this.iconCache.has(iconId)) this.iconCache.set(iconId, this.iconLoader(icon));
      const image = await this.iconCache.get(iconId);
      if (this.removed || !this.styleLoaded || version !== this.renderVersion || styleVersion !== this.styleVersion) return;
      if (!this.map.hasImage(iconId)) this.map.addImage(iconId, image, { pixelRatio: 2 });
      const data = { type: 'FeatureCollection', features: [...this.posts.values()].map((post) => ({ type: 'Feature',
        properties: { slug: post.slug }, geometry: { type: 'Point', coordinates: [post.location_lng, post.location_lat] },
      })) };
      const source = this.map.getSource(POST_SOURCE);
      if (source) source.setData(data);
      else this.map.addSource(POST_SOURCE, { type: 'geojson', data });
      const layout = { 'icon-image': iconId, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-anchor': 'center', 'icon-offset': [icon.size[0] / 2 - icon.anchor[0], icon.size[1] / 2 - icon.anchor[1]],
        'symbol-z-order': 'viewport-y',
      };
      if (this.map.getLayer(POST_LAYER)) {
        for (const [name, value] of Object.entries(layout)) this.map.setLayoutProperty(POST_LAYER, name, value);
      } else this.map.addLayer({ id: POST_LAYER, type: 'symbol', source: POST_SOURCE, layout });
    } catch (error) {
      this.iconCache.delete(iconId);
      if (!this.removed && version === this.renderVersion) this.onStatus({ loading: false, error: '地点のアイコンを読み込めません。再試行してください。' });
      console.warn('Map markers:', error);
    }
  }

  hasPost(slug) { return this.posts.has(slug); }

  focusPost(slug, { animate = true } = {}) {
    const post = this.posts.get(slug);
    if (!post) return;
    const version = ++this.focusVersion;
    this.map.stop();
    this.popup?.remove();
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      this.map.off('moveend', complete);
      if (!this.removed && version === this.focusVersion && this.posts.has(slug)) this.openPopup(slug);
    };
    this.map.once('moveend', complete);
    this.map.flyTo({ center: [post.location_lng, post.location_lat], zoom: this.map.getZoom(),
      offset: [0, (this.padding.top - this.padding.bottom) / 2], duration: animate ? 1500 : 0 });
    if (!this.map.isMoving()) complete();
  }

  openPopup(slug) {
    const post = this.posts.get(slug);
    if (!post) return;
    this.popup?.remove();
    const content = document.createElement('div');
    content.className = 'archive-popup-body';
    const image = document.createElement('img');
    image.alt = this.dataset.name + 'の投稿写真';
    image.src = this.photoURL(post);
    image.addEventListener('load', () => this.fitPopup());
    image.addEventListener('error', () => { image.src = 'static/img/loading-photo.png'; }, { once: true });
    content.append(image);
    if (post.caption) {
      const caption = document.createElement('p');
      caption.textContent = post.caption;
      content.append(caption);
    }
    const tags = document.createElement('ul');
    for (const tag of [this.dataset.name, ...(post.hashtag_names || [])]) {
      const item = document.createElement('li');
      item.textContent = tag;
      tags.append(item);
    }
    content.append(tags);
    const popup = new this.library.Popup({ className: 'archive-popup', anchor: 'bottom',
      offset: this.dataset.icon.popup, maxWidth: '236px', focusAfterOpen: false,
    }).setLngLat([post.location_lng, post.location_lat]).setDOMContent(content);
    this.popup = popup;
    popup.on('close', () => { if (this.popup === popup) this.popup = null; });
    popup.addTo(this.map);
    this.onPopupOpen();
    this.fitPopup();
  }

  setViewport({ top = 16, bottom = 16 } = {}) {
    this.padding = { top, bottom, left: 16, right: 16 };
    this.fitPopup();
  }

  fitPopup() {
    const popup = this.popup;
    if (!popup?.isOpen()) return;
    const container = this.map.getContainer();
    const element = popup.getElement();
    const content = element.querySelector('.maplibregl-popup-content');
    const body = element.querySelector('.archive-popup-body');
    const available = container.clientHeight - this.padding.top - this.padding.bottom - 24;
    element.style.visibility = available < 40 ? 'hidden' : '';
    content.style.maxHeight = Math.max(0, available) + 'px';
    content.style.overflowY = 'hidden';
    if (body) {
      body.style.maxHeight = Math.max(0, available - 16) + 'px';
      body.style.overflowY = 'auto';
    }
    popup.setMaxWidth(Math.max(80, Math.min(236, container.clientWidth - 32)) + 'px');
    if (available < 40 || this.map.isMoving()) return;
    const point = this.map.project(popup.getLngLat());
    const [offsetX, offsetY] = this.dataset.icon.popup;
    const left = point.x + offsetX - element.offsetWidth / 2;
    const right = left + element.offsetWidth;
    const bottom = point.y + offsetY;
    const top = bottom - element.offsetHeight;
    const dx = Math.min(0, left - this.padding.left) || Math.max(0, right - container.clientWidth + this.padding.right);
    const dy = Math.min(0, top - this.padding.top) || Math.max(0, bottom - container.clientHeight + this.padding.bottom);
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) this.map.panBy([Math.round(dx), Math.round(dy)], { duration: 0 });
  }

  resize() { this.map.resize(); this.fitPopup(); }

  remove() {
    this.removed = true;
    this.loadVersion++;
    this.focusVersion++;
    this.styleAbort?.abort();
    this.popup?.remove();
    this.map.remove();
    this.hybrid?.remove();
  }
}
