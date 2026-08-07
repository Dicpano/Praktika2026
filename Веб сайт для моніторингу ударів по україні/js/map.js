import { store, LEVELS, ALERT_TYPES, fmtDateTime } from './state.js';

let leafletMap = null;
let geoLayer = null;
let updatedEl = null;

function styleForFeature(feature) {
  const iso = feature.properties.iso;
  const level = store.oblastLevel(iso);
  return {
    fillColor: LEVELS[level].color,
    fillOpacity: level === 0 ? 0.35 : 0.65,
    color: '#0d0d0d',
    weight: 1,
    opacity: 0.8,
  };
}

function popupHtml(iso) {
  const oblast = store.oblastByIso(iso);
  const level = store.oblastLevel(iso);
  const recent = store.events.filter((e) => e.oblastIso === iso).slice(0, 5);

  const items = recent.length
    ? recent.map((e) => {
        const label = e.threatType === 'alert_end'
          ? 'Відбій тривоги'
          : (ALERT_TYPES[e.threatType]?.label ?? e.threatType);
        return `<li>${fmtDateTime(e.timestamp)} · ${escapeHtml(label)}</li>`;
      }).join('')
    : '<li>Подій ще не зафіксовано</li>';

  return `
    <div class="oblast-popup">
      <h4>${escapeHtml(oblast?.name_ua ?? iso)}</h4>
      <div class="status-line">
        <span class="status-dot" style="background:${LEVELS[level].color}"></span>
        <span>${LEVELS[level].label}</span>
      </div>
      <ul>${items}</ul>
    </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function initMap() {
  updatedEl = document.getElementById('map-updated');

  leafletMap = L.map('map', {
    center: [48.85, 31.2],
    zoom: 5,
    minZoom: 4,
    maxZoom: 8,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(leafletMap);

  const res = await fetch('data/ukraine-oblasts.geojson');
  const geojson = await res.json();

  const oblasts = geojson.features.map((f) => ({
    iso: f.properties.iso,
    name_ua: f.properties.name_ua,
    name_en: f.properties.name_en,
  }));
  store.setOblasts(oblasts);

  geoLayer = L.geoJSON(geojson, {
    style: styleForFeature,
    onEachFeature: (feature, layer) => {
      const iso = feature.properties.iso;
      layer.bindPopup(() => popupHtml(iso));
      layer.on('mouseover', () => layer.setStyle({ weight: 2, color: '#ffffff' }));
      layer.on('mouseout', () => layer.setStyle({ weight: 1, color: '#0d0d0d' }));
    },
  }).addTo(leafletMap);

  leafletMap.fitBounds(geoLayer.getBounds(), { padding: [10, 10] });

  store.addEventListener('events:changed', refreshMap);
  refreshMap();

  return oblasts;
}

export function resizeMap() {
  if (leafletMap) leafletMap.invalidateSize();
}

function refreshMap() {
  if (!geoLayer) return;
  geoLayer.setStyle(styleForFeature);
  if (updatedEl) {
    updatedEl.textContent = `Оновлено: ${new Date().toLocaleTimeString('uk-UA')}`;
  }
}
