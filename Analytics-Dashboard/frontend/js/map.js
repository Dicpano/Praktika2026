// Карта України: OpenStreetMap + Leaflet + milsymbol.
// Знаки — за Порядком (наказ № 140); чого в ньому немає — за APP-6 / MIL-STD-2525C.
// Поведінка від масштабу (п. 5.4.3: розмір знака залежить від масштабу карти):
//   • розмір знака змінюється разом із зумом (CSS-змінна --s, без перемальовування SVG);
//   • дрібні ланки ховаються при віддаленні (пороги MIN_ZOOM_*), на масштабі 5 знаки зникають;
//   • текстові ампліфікатори — з масштабу 8,5.
// Засоби повітряного нападу противника (БпЛА, ракети, КАБ) на карті показано лише місцями уражень
// (знак «Вибух, підрив» п. 6.12 з власним підписом засобу, п. 2.2.16); траєкторії — ні, деталі — у звітах.
/* global L, GEO */
import { get } from './api.js';
import { state, toggleOblast, label } from './state.js';
import { BASE, BLUE, RED, READINESS, render, renderTarget, renderCP, echelonMark, iconHtml, crossForResult } from './symbols.js';
import { dtg, esc, num, isUnverified } from './format.js';

const UA_BOUNDS = L.latLngBounds([44.2, 22.0], [52.45, 40.3]);
const sizeForZoom = (z) => 14 + (Math.max(5, Math.min(12, z)) - 5) * 4;   // 14 px … 42 px
// Пороги ×10 (класи mz-N / zl-N): елемент із класом mz-N ховається, коли зум < N/10
const THRESHOLDS = [55, 65, 70, 80, 90, 95];
const MIN_ZOOM_ECHELON = { command: 55, corps: 55, brigade: 65, regiment: 70, battalion: 80, company: 95 };
const MIN_ZOOM_ENEMY = { army: 55, corps: 55, division: 65, brigade: 80, regiment: 80, battalion: 90, unknown: 90 };
const MIN_ZOOM_FLOW = { 1: 55, 2: 65, 3: 80, 4: 95 };
const EVENT_MIN_ZOOM = 55;
const LABEL_ZOOM = 8.5;
const SEA = '#035C6B', GOLD = '#C98A00';

const strip = (s) => (s || '').replace(/\s*\((умовна|умовний|умовне|ум\.)\)/g, '');

function popup(title, rows, extra = '', note = 'Синтетичні дані. По навчанню.') {
  const dl = rows.filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<dt>${esc(k)}:</dt><dd>${esc(v ?? 'немає відом.')}</dd>`).join('');
  return `<div class="pop"><h4>${esc(title)}</h4><dl>${dl}</dl>${extra}<div class="syn">${esc(note)}</div></div>`;
}

function sourceText(src, rel) {
  if (!src && !rel) return 'немає відом.';
  return `${src || '—'}, ${rel || '—'}${isUnverified(rel) ? ' (?) неперевірено' : ''}`;
}

const flowColor = (pct) => (pct > 10 ? RED : pct >= 5 ? GOLD : SEA);
// Засіб виявлення — скорочення джерел за п. 2.2.15 Порядку (пишуться чорним)
const CB_TAG = { radar: 'РЛР', uav: 'ПвР', sound: 'АР', visual: 'С' };
const ring = (r) => r.map(([lon, lat]) => [lat, lon]);
// «ОТУ-1 (умовне)» → у прапорці «ОТУ», ліворуч «1», праворуч — старший («ОСУВ»), під прапорцем «ОКП» (п. 6.1)
function cpParts(u) {
  const name = strip(u.short_name).trim();
  const m = name.match(/^([А-ЯІЇЄҐA-Z]+)(?:[-\s]+(.+))?$/u);
  return { echelon: echelonMark(u.sidc), inner: m ? m[1] : name, left: m?.[2] ?? '', kind: 'ОКП',
    right: strip(u.parent).replace(/\s*\(.*$/, '').trim() };
}

export class MapView {
  constructor(el, { panel = true, legendEl = null } = {}) {
    this.el = el;
    this.legendEl = legendEl;
    this.mono = false;
    this.choroModule = 'air';
    this.on = { oblasts: true, areas: true, line: true, enemy: true, units: true, impacts: true, artillery: true,
      cb: false, docs: false, alerts: true };
    // Набір шарів можна передати в URL: ?layers=docs,units,line
    if (state.layers) Object.keys(this.on).forEach((k) => { this.on[k] = state.layers.includes(k); });
    this.map = L.map(el, { minZoom: 5, maxZoom: 12, maxBounds: UA_BOUNDS.pad(0.25), maxBoundsViscosity: 0.8,
      zoomSnap: 0.5, zoomDelta: 0.5, wheelPxPerZoomLevel: 120, preferCanvas: false, attributionControl: true });
    this.initBasemap();
    if (state.view) this.map.setView(state.view.c, state.view.z);
    else this.map.fitBounds(UA_BOUNDS);

    // Полігони й лінії малюються на одному canvas: при зміні масштабу не перебудовуються сотні SVG-шляхів
    this.vec = L.canvas({ padding: 0.3, tolerance: 3 });
    const cluster = (z, kind, r = 50) => L.markerClusterGroup({ disableClusteringAtZoom: z, maxClusterRadius: r,
      showCoverageOnHover: false, animate: false, chunkedLoading: true,
      iconCreateFunction: (c) => this.clusterIcon(c, kind) });
    // Знаки своїх і противника, що не мають бути видні на поточному масштабі, прибираються з карти (а не ховаються CSS)
    this.zMarkers = [];
    this.g = {
      oblasts: L.layerGroup(), areas: L.layerGroup(), alerts: L.layerGroup(), line: L.layerGroup(), docs: L.layerGroup(),
      enemy: L.layerGroup(), units: L.layerGroup(), impacts: cluster(8, 'imp', 22), artillery: cluster(11, 'art', 45), cb: cluster(10, 'art', 35),
    };
    Object.entries(this.g).forEach(([k, layer]) => { if (this.on[k]) layer.addTo(this.map); });

    this.addHomeButton();
    if (panel) this.addPanel();
    const apply = (z) => this.applyZoom(z);
    this.map.on('zoomanim', (e) => apply(e.zoom));
    this.map.on('zoomend', () => {
      const z = this.map.getZoom();
      apply(z);
      this.syncZoomMarkers(z);
      if (z !== this.lineZoom) this.drawLine();   // дуги залежать лише від масштабу, не від зсуву
    });
    // Дуги рахуються лише для видимої частини (з запасом); при виході за неї — перерахунок
    this.map.on('moveend', () => {
      if (this.lineBounds && this.map.getZoom() === this.lineZoom && !this.lineBounds.contains(this.map.getPixelBounds())) this.drawLine();
    });
    this.applyZoom(this.map.getZoom());
  }

  // ---- Підкладка: OSM (потрібен інтернет) або векторна «Схема» з Natural Earth (data/basemap.js, без інтернету) ----
  initBasemap() {
    const tail = 'межі: geoBoundaries (CC BY 4.0); лінія зіткнення, зони, противник: '
      + '<a href="https://deepstatemap.live" target="_blank" rel="noopener">DeepStateMap</a>. Свої підрозділи й події — синтетичні.';
    this.osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; ${tail}`,
    });
    // Жоден тайл не завантажився, а помилок уже кілька — інтернету немає: автоматично вмикаємо схему
    let ok = 0, fail = 0;
    this.osm.on('tileload', () => { ok += 1; });
    this.osm.on('tileerror', () => {
      fail += 1;
      if (!ok && fail >= 4 && this.baseMode === 'osm' && window.BASEMAP) { this.autoSchema = true; this.setBasemap('schema', false); }
    });
    this.schema = L.layerGroup();
    this.schemaTail = `Підкладка: Natural Earth (суспільне надбання); ${tail}`;
    let saved = null;
    try { saved = localStorage.getItem('basemap'); } catch { /* сховище недоступне */ }
    // Сторінка, відкрита як файл (file://), не має адреси для Referer — OSM на такі запити віддає заглушку
    // «Access blocked». Тому в офлайн-файлі OSM недоступна і завжди показується схема.
    this.osmAllowed = location.protocol !== 'file:' || !window.BASEMAP;
    const want = !this.osmAllowed ? 'schema' : saved || (navigator.onLine === false ? 'schema' : 'osm');
    this.setBasemap(window.BASEMAP ? want : 'osm', false);
  }

  setBasemap(mode, remember = true) {
    this.baseMode = mode;
    if (remember) { try { localStorage.setItem('basemap', mode); } catch { /* немає сховища */ } }
    const schema = mode === 'schema';
    if (schema) {
      this.map.removeLayer(this.osm);
      if (!this.schemaBuilt) this.buildSchema();
      this.schema.addTo(this.map);
      this.syncCityLabels();
    } else {
      this.map.removeLayer(this.schema);
      this.osm.addTo(this.map);
    }
    this.el.classList.toggle('base-schema', schema);
    const attr = this.map.attributionControl;
    if (attr) {
      attr.removeAttribution(this.schemaTail);
      if (schema) attr.addAttribution(this.schemaTail);
    }
    const sel = this.el.parentElement?.querySelector('[data-base]');
    if (sel) sel.value = mode;
    const note = this.el.parentElement?.querySelector('.basenote');
    if (note) note.textContent = schema && this.autoSchema ? 'Немає зʼєднання з OpenStreetMap — показано схему без інтернету.' : '';
  }

  buildSchema() {
    const B = window.BASEMAP;
    this.schemaBuilt = true;
    const pane = (name, z) => { const p = this.map.createPane(name); p.style.zIndex = z; p.style.pointerEvents = 'none'; return name; };
    const r = L.canvas({ pane: pane('basemap', 150), padding: 0.3 });
    pane('basemapLabels', 390);
    const ll = (pts) => pts.map(([lon, lat]) => [lat, lon]);
    const opt = { renderer: r, interactive: false, smoothFactor: 1 };
    B.land.forEach((poly) => L.polygon(poly.map(ll), { ...opt, stroke: false, fillColor: '#F3F0E6', fillOpacity: 1 }).addTo(this.schema));
    B.lakes.forEach((poly) => L.polygon(poly.map(ll), { ...opt, color: '#7FA8C4', weight: 0.6, fillColor: '#BFD6E6', fillOpacity: 1 }).addTo(this.schema));
    L.polyline(B.rivers.map(ll), { ...opt, color: '#7FA8C4', weight: 1.2 }).addTo(this.schema);
    L.polyline(B.borders.map(ll), { ...opt, color: '#6B5E7B', weight: 1.4, dashArray: '6 3 1.5 3' }).addTo(this.schema);
    // Міста: точка + підпис; дрібніші (більший rank) з'являються при наближенні
    this.cities = B.cities.map((c) => ({
      r: c.r,
      m: L.marker(c.ll, { pane: 'basemapLabels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'city', iconSize: null,
          html: `<i class="${c.cap ? 'cap' : ''}"></i><span>${esc(c.n)}</span>` }) }),
    }));
    this.map.on('zoomend', () => this.syncCityLabels());
  }

  syncCityLabels() {
    if (!this.cities || this.baseMode !== 'schema') return;
    const z = this.map.getZoom();
    const maxRank = z < 6 ? 3 : z < 7 ? 4 : z < 8 ? 6 : z < 9 ? 7 : 8;
    this.cities.forEach(({ r, m }) => {
      const want = r <= maxRank, has = this.schema.hasLayer(m);
      if (want && !has) this.schema.addLayer(m);
      else if (!want && has) this.schema.removeLayer(m);
    });
  }

  // Додає/прибирає маркери ланок за порогом масштабу (min — у десятих, як класи mz-N)
  syncZoomMarkers(z = this.map.getZoom()) {
    const zz = z * 10, labels = z >= LABEL_ZOOM;
    this.zMarkers.forEach(({ m, min, group, bare, full }) => {
      const want = zz >= min;
      // один SVG на знак: без підписів на загальному виді, з ампліфікаторами — при наближенні
      const icon = labels ? full : bare;
      if (icon && m.options.icon !== icon && (want || !group.hasLayer(m))) m.setIcon(icon);
      if (want && !group.hasLayer(m)) group.addLayer(m);
      else if (!want && group.hasLayer(m)) group.removeLayer(m);
    });
  }

  clusterIcon(c, kind) {
    const n = c.getChildCount();
    const s = n < 10 ? 28 : n < 100 ? 34 : 40;
    return L.divIcon({ html: `<div class="cluster ${kind}" style="width:${s}px;height:${s}px">${n}</div>`,
      className: `mz-${EVENT_MIN_ZOOM}`, iconSize: [s, s] });
  }

  applyZoom(z) {
    const c = this.el;
    c.style.setProperty('--s', (sizeForZoom(z) / BASE).toFixed(3));
    THRESHOLDS.forEach((t) => c.classList.toggle(`zl-${t}`, z * 10 < t));
    c.classList.toggle('labels-on', z >= LABEL_ZOOM);
    const light = z >= 7;
    if (this.choroLight !== light) {
      this.choroLight = light;
      this.choroLayer?.setStyle({ fillOpacity: light ? 0.25 : 0.45 });
    }
    const zn = c.parentElement?.querySelector('.zoomnote');
    if (zn) zn.textContent = `Масштаб ${String(z).replace('.', ',')}: ${this.zoomHint(z)}`;
  }

  zoomHint(z) {
    if (z < 5.5) return 'лише області; наблизьте для знаків';
    if (z < 6.5) return "ОСУВ, ОТУ, армії й корпуси противника; події об'єднано в кластери";
    if (z < 7) return '+ бригади; дивізії противника';
    if (z < 8) return '+ полки';
    if (z < 8.5) return '+ батальйони; бригади й полки противника';
    if (z < 9) return '+ підписи знаків';
    if (z < 9.5) return '+ батальйони противника';
    return 'усі ланки, включно з ротами';
  }

  addHomeButton() {
    const Home = L.Control.extend({
      onAdd: () => {
        const b = L.DomUtil.create('button', 'btn sm');
        b.type = 'button';
        b.textContent = 'Вся Україна';
        b.style.background = '#fff';
        b.setAttribute('aria-label', 'Показати всю Україну');
        L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); this.map.fitBounds(UA_BOUNDS); });
        return b;
      },
    });
    new Home({ position: 'topleft' }).addTo(this.map);
  }

  addPanel() {
    const p = document.createElement('div');
    p.className = 'map-panel';
    const names = { oblasts: 'Області (хороплет)', areas: 'Окупована і «сіра» зони', line: 'Лінія зіткнення',
      enemy: 'Підрозділи противника', units: 'Свої підрозділи (умовні)', impacts: 'Місця уражень (A)',
      artillery: 'Артилерійський вогонь (B)', cb: 'Контрбатарейна боротьба (B)', docs: 'Потоки документів ОКП (D)', alerts: 'Тривоги зараз' };
    p.innerHTML = `<fieldset><legend>Шари</legend>${Object.entries(names).map(([k, n]) =>
      `<label><input type="checkbox" data-layer="${k}" ${this.on[k] ? 'checked' : ''}> ${n}</label>`).join('')}</fieldset>
      <label style="display:block;margin-top:6px">Хороплет:
        <select data-choro aria-label="Метрика хороплета">
          <option value="air">Засоби повітряного нападу</option><option value="artillery">Постріли противника</option>
          <option value="alerts">Тривалість тривог</option><option value="losses">Втрати</option>
          <option value="docs">Документи від підрозділів</option></select></label>
      <label><input type="checkbox" data-mono> Монохромний (друк)</label>
      <label style="display:block;margin-top:6px">Підкладка:
        <select data-base aria-label="Підкладка карти">
          <option value="osm" ${this.osmAllowed ? '' : 'disabled'}>OpenStreetMap (інтернет${this.osmAllowed ? '' : '; лише через сервер'})</option>
          <option value="schema" ${window.BASEMAP ? '' : 'disabled'}>Схема (без інтернету)</option></select></label>
      <div class="basenote"></div>
      <div class="zoomnote"></div>`;
    L.DomEvent.disableClickPropagation(p);
    L.DomEvent.disableScrollPropagation(p);
    this.el.parentElement.appendChild(p);
    p.querySelectorAll('[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
      const k = cb.dataset.layer;
      this.on[k] = cb.checked;
      if (cb.checked) this.g[k].addTo(this.map); else this.map.removeLayer(this.g[k]);
      this.renderLegend();
    }));
    const base = p.querySelector('[data-base]');
    base.value = this.baseMode;
    base.addEventListener('change', (e) => { this.autoSchema = false; this.setBasemap(e.target.value); });
    p.querySelector('[data-choro]').addEventListener('change', (e) => { this.choroModule = e.target.value; this.drawChoropleth(); });
    p.querySelector('[data-mono]').addEventListener('change', (e) => {
      this.mono = e.target.checked;
      this.redrawSymbols(); this.drawLine(); this.drawAreas();
    });
    this.applyZoom(this.map.getZoom());
  }

  async refresh() {
    const seq = (this.seq = (this.seq || 0) + 1);
    this.restyleSelection();   // виділення області змінюється одразу, не чекаючи даних
    const [units, impacts, art, cb, flows, alerts, line, enemy] = await Promise.all([
      get('map/units'), get('air/impacts'), get('artillery/geojson'), get('artillery/cb-geojson'), get('map/flows'),
      get('alerts/active', {}, { filters: false }), get('map/contact-line', {}, { filters: false }),
      get('map/enemy-units', {}, { filters: false }),
    ]);
    if (seq !== this.seq) return;   // за цей час фільтр змінився ще раз — застарілу відповідь не малюємо
    Object.assign(this, { geo: GEO.oblasts, units, impacts, art, cb, flows, alerts, line, enemy });
    await this.drawChoropleth();
    if (seq !== this.seq) return;
    this.drawAreas();
    this.drawAlerts();
    this.drawLine();
    this.redrawSymbols();
    this.drawFlows();
  }

  async drawChoropleth() {
    const ch = await get('map/choropleth', { module: this.choroModule });
    const vals = Object.fromEntries(ch.values.map((v) => [v.iso_code, v.value]));
    const sorted = ch.values.map((v) => v.value).filter((v) => v > 0).sort((a, b) => a - b);
    const q = [0.2, 0.4, 0.6, 0.8].map((p) => sorted[Math.floor(p * (sorted.length - 1))] ?? 0);
    const css = getComputedStyle(document.documentElement);
    const ramp = [1, 2, 3, 4, 5].map((i) => css.getPropertyValue(`--seq-${i}`).trim());
    const cls = (v) => (!v ? 0 : v <= q[0] ? 0 : v <= q[1] ? 1 : v <= q[2] ? 2 : v <= q[3] ? 3 : 4);
    this.choro = { label: ch.label, q, ramp };
    this.g.oblasts.clearLayers();
    this.choroLight = this.map.getZoom() >= 7;
    this.choroLayer = L.geoJSON(this.geo, {
      renderer: this.vec, smoothFactor: 1.5,
      style: (f) => ({ ...this.selStyle(f), fillColor: ramp[cls(vals[f.properties.iso])], fillOpacity: this.choroLight ? 0.25 : 0.45 }),
      onEachFeature: (f, layer) => {
        layer.bindTooltip(`${esc(f.properties.name_ua)}: ${num(vals[f.properties.iso], 1)} (${esc(ch.label)})`, { sticky: true });
        layer.on('click', (e) => {
          const ev = e.originalEvent || {};
          toggleOblast(f.properties.iso, ev.ctrlKey || ev.metaKey || ev.shiftKey);
        });
      },
    }).addTo(this.g.oblasts);
    this.choroLayer.bringToBack();   // області — найнижчий шар під зонами й лінією
    this.renderLegend();
  }

  selStyle(f) {
    const sel = state.oblast.includes(f.properties.iso);
    return { color: sel ? '#F39200' : '#4D4634', weight: sel ? 3 : 0.8 };
  }

  // Лише контур вибраних областей — без запиту даних
  restyleSelection() {
    this.choroLayer?.eachLayer((l) => {
      l.setStyle(this.selStyle(l.feature));
      if (state.oblast.includes(l.feature.properties.iso)) l.bringToFront();
    });
  }

  // Окупована та «сіра» зони — заливка поверх хороплета (власний знак, пояснено в легенді, п. 2.2.16)
  drawAreas() {
    this.g.areas.clearLayers();
    const asOf = GEO.deepstate?.as_of ?? '';
    const tip = (t) => `${t} — за даними DeepStateMap (deepstatemap.live), станом на ${asOf}`;
    GEO.occupied.forEach((poly) => L.polygon(poly.map(ring), {
      renderer: this.vec, smoothFactor: 1.5, stroke: false, fillColor: this.mono ? '#000' : RED, fillOpacity: this.mono ? 0.12 : 0.16, interactive: true,
    }).bindTooltip(esc(tip('Тимчасово окупована територія')), { sticky: true }).addTo(this.g.areas));
    GEO.grey.forEach((poly) => L.polygon(poly.map(ring), {
      renderer: this.vec, smoothFactor: 1.5, color: '#707276', weight: 0.5, fillColor: '#707276', fillOpacity: 0.3, interactive: true,
    }).bindTooltip(esc(tip('«Сіра» зона (неконтрольована)')), { sticky: true }).addTo(this.g.areas));
  }

  drawAlerts() {
    this.g.alerts.clearLayers();
    const active = new Map(this.alerts.map((a) => [a.iso_code, a]));
    L.geoJSON(this.geo, {
      renderer: this.vec, smoothFactor: 1.5,
      filter: (f) => active.has(f.properties.iso),
      style: { color: '#E52421', weight: 3, dashArray: '6 4', fill: false, interactive: true },
      onEachFeature: (f, layer) => {
        const a = active.get(f.properties.iso);
        layer.bindPopup(popup(`Тривога: ${f.properties.name_ua}`, [
          ['Тип', label('alert_type', a.alert_type)], ['Початок', dtg(a.started_at)], ['Стан', 'триває (на кінець даних)']]));
      },
    }).addTo(this.g.alerts);
  }

  // Лінія зіткнення (п. 6.2.1 Порядку): лінія своїх військ — синя з дугами в бік противника;
  // лінія противника — червона з дугами в бік своїх. Монохромно (п. 2.2.13): свої — одинарна, противник — подвійна.
  // Дуги будуються в пікселях поточного масштабу, тому перемальовуються після зміни зуму.
  drawLine() {
    if (!this.line) return;
    this.g.line.clearLayers();
    const m = this.map, z = m.getZoom();
    this.lineZoom = z;
    const R = { renderer: this.vec };
    const step = 9 + (z - 5) * 1.2;                // крок дуг, px
    const pt = (la, lo) => m.project([la, lo], z);
    const back = (p) => m.unproject(p, z);
    // Дуги вздовж усієї ламаної (крок у пікселях не залежить від густоти вершин)
    const scallop = (pts, toward) => {
      const cum = [0];
      for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
      const total = cum[cum.length - 1];
      let j = 0;
      const at = (s) => {
        while (j < pts.length - 2 && cum[j + 1] < s) j += 1;
        while (j > 0 && cum[j] > s) j -= 1;
        const a = pts[j], b = pts[j + 1], sl = (cum[j + 1] - cum[j]) || 1, t = (s - cum[j]) / sl;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ux: (b.x - a.x) / sl, uy: (b.y - a.y) / sl, i: j };
      };
      const out = [];
      for (let s = 0; s + step <= total; s += step) {
        const c = at(s + step / 2);
        let nx = -c.uy, ny = c.ux;
        if (nx * toward[c.i].x + ny * toward[c.i].y < 0) { nx = -nx; ny = -ny; }
        for (let k = 0; k <= 4; k += 1) {
          const th = Math.PI * (k / 4);
          const p = at(s + step / 2 - Math.cos(th) * step / 2);
          const off = Math.sin(th) * step / 2.2;
          out.push(back(L.point(p.x + nx * off, p.y + ny * off)));
        }
      }
      return out;
    };
    const offset = (pts, d) => pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const len = a.distanceTo(b) || 1;
      return back(L.point(p.x - (b.y - a.y) / len * d, p.y + (b.x - a.x) / len * d));
    });
    const tip = `Лінія зіткнення за відкритими даними DeepStateMap, станом на ${this.line.as_of}. Не є офіційними даними.`;
    // Видима область + запас 60 % з кожного боку (у пікселях поточного масштабу)
    const pb = m.getPixelBounds(), padPx = pb.getSize().multiplyBy(0.6);
    const vis = L.bounds(pb.min.subtract(padPx), pb.max.add(padPx));
    this.lineBounds = vis;
    this.line.segments.forEach((seg) => {
      if (seg.length < 2) return;
      const ownAll = seg.map(([la, lo]) => pt(la, lo));
      const enAll = seg.map(([, , ela, elo]) => pt(ela, elo));
      // неперервні ділянки, що потрапляють у видиму область (з однією сусідньою вершиною для гладкості)
      const inside = ownAll.map((p, i) => vis.contains(p) || vis.contains(enAll[i]));
      const runs = [];
      let start = -1;
      inside.forEach((v, i) => {
        if (v && start < 0) start = Math.max(0, i - 1);
        if ((!v || i === inside.length - 1) && start >= 0) { runs.push([start, Math.min(inside.length, i + 2)]); start = -1; }
      });
      runs.forEach(([a, b]) => {
        const own = ownAll.slice(a, b), en = enAll.slice(a, b);
        if (own.length < 2) return;
        const dir = own.map((p, i) => L.point(en[i].x - p.x, en[i].y - p.y));
        const back2 = dir.map((d) => L.point(-d.x, -d.y));
        if (this.mono) {
          L.polyline(scallop(own, dir), { ...R, color: '#000', weight: 1.6, interactive: false }).addTo(this.g.line);
          L.polyline(offset(en, 2), { ...R, color: '#000', weight: 1.2, interactive: false }).addTo(this.g.line);
          L.polyline(offset(en, -2), { ...R, color: '#000', weight: 1.2, interactive: false }).addTo(this.g.line);
        } else {
          L.polyline(scallop(own, dir), { ...R, color: BLUE, weight: 2, interactive: false }).addTo(this.g.line);
          L.polyline(scallop(en, back2), { ...R, color: RED, weight: 2, interactive: false }).addTo(this.g.line);
        }
      });
      L.polyline(seg.map(([la, lo]) => [la, lo]), { ...R, opacity: 0, weight: 14 }).bindTooltip(esc(tip), { sticky: true }).addTo(this.g.line);
    });
  }

  // Потоки документів ОКП ієрархічно: кожне ребро — «підлеглий → старший» пункт управління,
  // вага — кількість документів, що пройшли ланкою. Видимість ребер — за тими ж порогами, що й знаки:
  // на загальному виді лише ОТУ → ОСУВ, при наближенні з'являються бригади, батальйони, роти.
  drawFlows() {
    this.g.docs.clearLayers();
    const edges = this.flows?.edges ?? [];
    if (!edges.length) return;
    const maxBy = {};
    edges.forEach((e) => { maxBy[e.level] = Math.max(maxBy[e.level] || 0, e.docs); });
    edges.forEach((e) => {
      const mz = `mz-${MIN_ZOOM_FLOW[e.level]}`;
      const w = 1.5 + 6 * Math.sqrt(e.docs / maxBy[e.level]) * (e.level === 1 ? 1.3 : 1);
      const col = this.mono ? '#000' : flowColor(e.overdue_pct);
      const a = [e.from_lat, e.from_lon], b = [e.to_lat, e.to_lon];
      const tip = `${esc(strip(e.from))} → ${esc(strip(e.to))}: ${num(e.docs)} док., прострочено ${num(e.overdue_pct, 1)} %`;
      L.polyline([a, b], { color: col, weight: w, opacity: 0.8, lineCap: 'round', className: mz })
        .bindTooltip(tip, { sticky: true }).addTo(this.g.docs);
      const pa = this.map.project(a, 0), pb = this.map.project(b, 0);
      const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      const mid = [a[0] + (b[0] - a[0]) * 0.6, a[1] + (b[1] - a[1]) * 0.6];
      L.marker(mid, { interactive: false, keyboard: false,
        icon: L.divIcon({ className: `flow-arrow ${mz}`, iconSize: [0, 0],
          html: `<i style="color:${col};transform:rotate(${ang.toFixed(1)}deg)"></i>` }) }).addTo(this.g.docs);
    });
    (this.flows.posts || []).forEach((p) => {
      L.marker([p.lat, p.lon], { interactive: false, keyboard: false, zIndexOffset: 900,
        icon: L.divIcon({ className: `post-badge mz-${EVENT_MIN_ZOOM}`, iconSize: [0, 0],
          html: `<b>${num(p.docs)} док. · ${num(p.overdue_pct, 1)} %</b>` }) }).addTo(this.g.docs);
    });
  }

  redrawSymbols() {
    const mono = this.mono;
    // Свої підрозділи (без кластеризації — видимість керується ланкою і зумом)
    this.g.units.clearLayers();
    this.zMarkers = [];
    this.units.forEach((u) => {
      const cp = u.echelon === 'command' || u.echelon === 'corps';
      const amps = u.echelon === 'command'
        ? { uniqueDesignation: 'ОКП', higherFormation: strip(u.short_name) }
        : u.echelon === 'corps' ? { uniqueDesignation: strip(u.short_name), higherFormation: 'КП' }
          : { uniqueDesignation: strip(u.short_name).split('/')[0], higherFormation: strip(u.parent).replace(/\s*\(.*$/, '') };
      const common = { mono, readiness: cp ? null : u.readiness };
      let bare, full;
      if (cp) {
        // Пункт управління угруповання — власне креслення за п. 6.1 Порядку (milsymbol малює його інакше)
        const o = { mono, ...cpParts(u) };
        bare = renderCP({ ...o, text: false });
        full = renderCP(o);
      } else {
        bare = render(u.sidc, { ...common, text: false });
        full = render(u.sidc, { ...common, text: true, amps });
      }
      const mz = `mz-${MIN_ZOOM_ECHELON[u.echelon] ?? 80}`;
      const dim = u.selected ? '' : ' dim';
      const ib = L.divIcon({ className: 'sym-wrap', html: iconHtml(bare, `bare ${mz}${dim}`), iconSize: [0, 0] });
      const ifl = L.divIcon({ className: 'sym-wrap', html: iconHtml(full, `full ${mz}${dim}`), iconSize: [0, 0] });
      const m = L.marker([u.lat, u.lon], { icon: ib,
        title: u.short_name, keyboard: true, zIndexOffset: cp ? 800 : u.echelon === 'company' ? 0 : 500 });
      const losses = u.killed + u.wounded + u.missing;
      m.bindPopup(popup(u.name_ua, [
        ['Скорочено', u.short_name], ['Ланка', label('echelon', u.echelon)], ['Старший начальник', u.parent || '—'],
        ['Область', u.oblast_ua], ['Втрати за період', `${num(losses)} осіб (загиблі ${num(u.killed)}, поранені ${num(u.wounded)}, зниклі ${num(u.missing)})`],
        ['Боєздатність (AL)', cp ? undefined : READINESS[u.readiness]?.label],
        ['Походження', u.origin && u.origin !== 'synthetic' ? label('origin', u.origin) : undefined],
      ], '', 'Умовний підрозділ. Синтетичні дані. По навчанню.'));
      this.zMarkers.push({ m, min: MIN_ZOOM_ECHELON[u.echelon] ?? 80, group: this.g.units, bare: ib, full: ifl });
    });

    // Противник — відкриті дані DeepStateMap (координати без змін)
    this.g.enemy.clearLayers();
    (this.enemy?.rows ?? []).forEach((u) => {
      const amps = { uniqueDesignation: u.label };
      const bare = render(u.sidc, { mono, text: false });
      const full = render(u.sidc, { mono, text: true, amps });
      const mz = `mz-${MIN_ZOOM_ENEMY[u.echelon] ?? 80}`;
      const ib = L.divIcon({ className: 'sym-wrap', html: iconHtml(bare, `bare ${mz}`), iconSize: [0, 0] });
      const ifl = L.divIcon({ className: 'sym-wrap', html: iconHtml(full, `full ${mz}`), iconSize: [0, 0] });
      const m = L.marker([u.lat, u.lon], { icon: ib,
        title: u.label, keyboard: true, zIndexOffset: 400 });
      m.bindPopup(popup(u.name_ua, [['Скорочено', u.label], ['Ланка', label('echelon', u.echelon)],
        ['Джерело', `${u.source}, станом на ${u.as_of}`]], '', 'Відкриті дані (OSINT) DeepStateMap; не є офіційними даними.'));
      this.zMarkers.push({ m, min: MIN_ZOOM_ENEMY[u.echelon] ?? 80, group: this.g.enemy, bare: ib, full: ifl });
    });
    this.syncZoomMarkers();

    // Місця уражень: знак «Вибух, підрив» (п. 6.12) + підпис засобу (БпЛА, КрР, БалР, КАБ)
    this.g.impacts.clearLayers();
    this.impacts.features.forEach((f) => {
      const p = f.properties;
      const r = render(p.sidc, { mono, text: false, tag: p.map_label, unverified: isUnverified(p.reliability) });
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        icon: L.divIcon({ className: 'sym-wrap', html: iconHtml(r, `mz-${EVENT_MIN_ZOOM}`), iconSize: [0, 0] }), title: `Ураження: ${p.weapon_name}` });
      m.bindPopup(popup(`Місце ураження: ${p.map_label}`, [
        ['Час', dtg(p.occurred_at)], ['Засіб', p.weapon_name], ['Область', p.oblast], ['Запущено', num(p.launched)],
        ['Влучань', num(p.hits)], ['Обʼєкт', p.target], ['Ступінь руйнувань', `${p.damage_level} з 3`],
        ['Джерело, достовірність', sourceText(p.info_source, p.reliability)],
        ['Походження', p.origin && p.origin !== 'synthetic' ? label('origin', p.origin) : undefined]]));
      this.g.impacts.addLayer(m);
    });

    // Артилерія: вогонь противника — знак його засобу на виявленій вогневій позиції (ромб, табл. 4, 16);
    // вогонь своїх засобів — знак цілі «Вогонь по одиночній цілі» (п. 6.2.2) синім, з позначкою результату (п. 2.2.12)
    this.g.artillery.clearLayers();
    this.art.features.forEach((f) => {
      const p = f.properties;
      const outgoing = p.direction === 'outgoing';
      const r = outgoing
        ? renderTarget({ mono, label: String(p.id % 10000), cross: crossForResult(p.result), unverified: isUnverified(p.reliability) })
        : render(p.sidc, { mono, text: false, unverified: isUnverified(p.reliability) });
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        icon: L.divIcon({ className: 'sym-wrap', html: iconHtml(r, `mz-${EVENT_MIN_ZOOM}`), iconSize: [0, 0] }),
        title: label('system_type', p.system_type) });
      m.bindPopup(popup(outgoing ? `Ціль № ${p.id % 10000}: вогонь своїх засобів` : 'Вогнева позиція противника (виявлена)', [
        ['Час', dtg(p.occurred_at)], [outgoing ? 'Чим вражено' : 'Система', `${label('system_type', p.system_type)}, ${p.caliber_mm ?? '—'} мм (${label('caliber_class', p.caliber_class)})`],
        ['Пострілів', num(p.rounds)], ['Підрозділ', p.unit], ['Результат', label('result', p.result)], ['Область', p.oblast],
        ['Джерело, достовірність', sourceText(p.info_source, p.reliability)]]));
      this.g.artillery.addLayer(m);
    });

    // Контрбатарейна боротьба: виявлена позиція противника, підпис — засіб виявлення; позначка результату вогню у відповідь
    this.g.cb.clearLayers();
    (this.cb?.features ?? []).forEach((f) => {
      const p = f.properties;
      const r = render(p.sidc, { mono, text: false, tag: CB_TAG[p.detected_by], tagColor: '#000', cross: crossForResult(p.result), crossColor: BLUE,
        unverified: isUnverified(p.reliability) });
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        icon: L.divIcon({ className: 'sym-wrap', html: iconHtml(r, `mz-${EVENT_MIN_ZOOM}`), iconSize: [0, 0] }),
        title: `Виявлена позиція: ${label('system_type', p.enemy_system)}` });
      m.bindPopup(popup('Виявлена вогнева позиція противника', [
        ['Виявлено', dtg(p.detected_at)], ['Засіб виявлення', label('detected_by', p.detected_by)],
        ['Система', `${label('system_type', p.enemy_system)}${p.caliber_mm ? `, ${p.caliber_mm} мм` : ''}`],
        ['Вогонь у відповідь', p.responded_at ? `${dtg(p.responded_at)}, ${p.unit ?? '—'}, ${num(p.rounds)} пострілів` : 'не відкривався'],
        ['Час реакції', p.reaction_min !== null && p.reaction_min !== undefined ? `${num(p.reaction_min)} хв` : undefined],
        ['Результат', label('result', p.result)], ['Область', p.oblast],
        ['Джерело, достовірність', sourceText(p.info_source, p.reliability)],
        ['Походження', p.origin && p.origin !== 'synthetic' ? label('origin', p.origin) : undefined]]));
      this.g.cb.addLayer(m);
    });
    this.drawFlows();
    this.renderLegend();
  }

  renderLegend() {
    if (!this.legendEl) return;
    const mono = this.mono;
    const rows = [];
    const sym = (sidc, o = {}) => render(sidc, { mono, size: 22, text: false, ...o }).svg;
    const ds = `DeepStateMap, станом на ${GEO.deepstate?.as_of ?? ''}`;
    if (this.on.units) {
      const cpSym = (sidc, name, parent) => renderCP({ mono, size: 18, ...cpParts({ sidc, short_name: name, parent }) }).svg;
      rows.push([cpSym('SFGPUH----AK---', 'ОСУВ'), 'Основний командний пункт (ОКП) оперативно-стратегічного угруповання військ: прапорець зі скороченням угруповання, флагшток спирається на точку розміщення (п. 6.1), ланка «XXXX» (табл. 8). Умовний']);
      rows.push([cpSym('SFGPUH----AJ---', 'ОТУ-1', 'ОСУВ'), 'ОКП оперативно-тактичного угруповання: ліворуч — найменування (номер), праворуч — підпорядкованість (п. 6.1), ланка «XXX». Умовний']);
      rows.push([sym('SFGPUCIZ---H---'), 'Своя механізована бригада; ланка — над знаком (табл. 8). Умовна, синтетична']);
      rows.push([Object.values(READINESS).map((r) => `<span style="display:inline-block;width:12px;height:8px;background:${r.color};border:1px solid #000;margin:1px"></span>`).join(''),
        'Смуга під знаком — боєздатність (поле AL): ' + Object.values(READINESS).map((r) => r.label).join(' / ')]);
    }
    if (this.on.enemy) rows.push([sym('SHGPUCIZ---H---'), `Підрозділ противника (механізована бригада). Положення — відкриті дані ${ds}`]);
    if (this.on.impacts) {
      rows.push([sym('OHVPE----------', { tag: 'КАБ' }), 'Місце ураження: знак «Вибух, підрив» (п. 6.12) з власним підписом засобу (п. 2.2.16)']);
      rows.push(['<b>БпЛА · КрР · БалР · КАБ</b>', 'Підписи: ударний БпЛА, крилата ракета, балістична ракета, керована авіабомба. Траєкторії не показуються — деталі у звітах модуля A']);
    }
    if (this.on.artillery) {
      rows.push([sym('SHGPEWHM-------'), 'Засіб вогневого ураження противника (гаубиця, середній калібр, табл. 16): виявлена вогнева позиція']);
      rows.push([renderTarget({ mono, size: 22, label: '401' }).svg, 'Вогонь своїх засобів по одиночній цілі з номером цілі (п. 6.2.2); синій — вогонь своєї артилерії (п. 2.2.2)']);
      rows.push([renderTarget({ mono, size: 22, cross: 'destroyed' }).svg, 'Ціль знищено: дві суцільні лінії (п. 2.2.12)']);
      rows.push([renderTarget({ mono, size: 22, cross: 'disabled' }).svg, 'Ціль виведено з ладу / подавлено: суцільна + пунктирна (п. 2.2.12)']);
    }
    if (this.on.cb) {
      rows.push([sym('SHGPEWHM-------', { tag: 'РЛР', tagColor: '#000', cross: 'disabled', crossColor: BLUE }), 'Контрбатарейна боротьба: виявлена вогнева позиція противника; підпис — джерело за п. 2.2.15 (РЛР — радіолокаційна, ПвР — повітряна, АР — артилерійська розвідка, С — спостереження); позначка — результат вогню у відповідь (п. 2.2.12)']);
    }
    if (this.on.impacts || this.on.artillery || this.on.cb) rows.push([sym('SHGPEWHM-------', { unverified: true }), '«?» — дані не перевірено (достовірність *4–*6, п. 2.2.15)']);
    if (mono) rows.push(['<b>ПТН</b>', 'Монохромний режим: противник позначається підписом «ПТН» або подвійною лінією (п. 2.2.13)']);
    if (this.on.line) {
      rows.push([mono
        ? '<svg width="48" height="16"><path d="M0 5 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0" fill="none" stroke="#000" stroke-width="1.6"/><line x1="0" y1="10" x2="48" y2="10" stroke="#000"/><line x1="0" y1="14" x2="48" y2="14" stroke="#000"/></svg>'
        : '<svg width="48" height="16"><path d="M0 6 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0 q4 -6 8 0" fill="none" stroke="#0057B7" stroke-width="2"/><path d="M0 10 q4 6 8 0 q4 6 8 0 q4 6 8 0 q4 6 8 0 q4 6 8 0 q4 6 8 0" fill="none" stroke="#D40000" stroke-width="2"/></svg>',
      `Лінія зіткнення (п. 6.2.1): синя — свої війська, червона — противник; дуги звернені до протилежної сторони. За даними ${ds}`]);
    }
    if (this.on.areas) {
      rows.push([`<span style="display:inline-block;width:40px;height:14px;background:${mono ? 'rgba(0,0,0,.12)' : 'rgba(212,0,0,.16)'};border:1px solid #999"></span>`,
        `Тимчасово окупована територія (власне позначення, п. 2.2.16). ${ds}`]);
      rows.push(['<span style="display:inline-block;width:40px;height:14px;background:rgba(112,114,118,.3);border:1px solid #707276"></span>', `«Сіра» зона. ${ds}`]);
    }
    if (this.on.docs) {
      rows.push([`<svg width="48" height="14"><line x1="2" y1="7" x2="38" y2="7" stroke="${SEA}" stroke-width="5" stroke-linecap="round"/><path d="M36 2 L46 7 L36 12 Z" fill="${SEA}"/></svg>`,
        'Потік документів «підлеглий → старший пункт управління»; товщина — обсяг (у межах ланки). На загальному виді — ОТУ → ОСУВ, при наближенні — бригади, батальйони, роти']);
      rows.push([[SEA, GOLD, RED].map((c) => `<span style="display:inline-block;width:14px;height:6px;background:${c};margin:1px"></span>`).join(''),
        'Частка прострочених: до 5 % / 5–10 % / понад 10 % (нормативи умовні); підпис біля ОКП — прийнято і прострочено']);
    }
    if (this.on.alerts) rows.push(['<svg width="48" height="10"><line x1="0" y1="5" x2="48" y2="5" stroke="#E52421" stroke-width="3" stroke-dasharray="6 4"/></svg>', 'Область з тривогою, що триває']);
    if (this.on.oblasts && this.choro) {
      const { q, ramp } = this.choro;
      rows.push([ramp.map((c) => `<span style="display:inline-block;width:12px;height:12px;background:${c};border:1px solid #999"></span>`).join(''),
        `${this.choro.label}: ≤${num(q[0])} … >${num(q[3])}`]);
    }
    this.legendEl.innerHTML = `<table class="t map-legend"><caption><b>УМОВНІ ПОЗНАЧЕННЯ</b></caption>
      <thead><tr><th>Знак</th><th>Зміст знака</th></tr></thead><tbody>${
  rows.map(([s, t]) => `<tr><td class="sym-cell">${s}</td><td>${esc(t)}</td></tr>`).join('')}</tbody></table>`;
  }

  invalidate() { this.map.invalidateSize(); }
}
