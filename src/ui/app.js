// App wiring: map, search, click-to-lookup, live layers.
/* global L */
import { reportForAddress, reportForPoint, suggest } from '../lib/lookup.js';
import { instrumentInForce } from '../lib/policy.js';
import { renderReport, renderLoading, renderError, renderNotOk } from './report.js';
import {
  ZoneStore, classifyParcels, zoneLayer, stopsLayer, parcelLayer,
  loadParcelsInView, loadExclusionsInView, parcelsToCSV,
  fireInView, fireLayer, annotateParcels, fireRuleJurisdictions, cityNamesInView, cityShapesInView,
} from './maplayers.js';

const REPO_URL = 'https://github.com/samalcorn3/sb-79-parcels';
const PARCEL_MIN_ZOOM = 17;
const STOPS_MIN_ZOOM = 12;
const FIRE_MIN_ZOOM = 12;

const $ = (id) => document.getElementById(id);
const reportEl = $('report');
const statusEl = $('map-status');

async function loadData() {
  const get = (n) => fetch(`data/${n}`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`Could not load data/${n}`);
    return r.json();
  });
  const [sources, standards, registry] = await Promise.all([get('sources.json'), get('standards.json'), get('jurisdictions.json')]);
  return { sources, standards, registry };
}

const statusParts = { zones: '', parcels: '' };
function setStatus(msg, channel = 'parcels') {
  statusParts[channel] = msg || '';
  const text = [statusParts.zones, statusParts.parcels].filter(Boolean).join(' · ');
  statusEl.hidden = !text;
  statusEl.textContent = text;
}

const data = await loadData().catch((e) => {
  reportEl.innerHTML = renderError(e.message);
  throw e;
});

$('repo-link').href = REPO_URL;
$('registry-link').href = `${REPO_URL}/blob/main/data/jurisdictions.json`;
$('build-info').textContent = `Registry reviewed ${data.registry.lastReviewed}`;

// ---------- map ----------
const initial = parseHash() || { z: 9, lat: 34.05, lon: -118.25 };
const map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([initial.lat, initial.lon], initial.z);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
// Basemaps: Esri's public tile services (no API key). The gray canvases have
// no detail past zoom 16, so Leaflet upscales those tiles at parcel zoom.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Powered by <a href="https://www.esri.com">Esri</a> | Esri, HERE, Garmin, USGS, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const esri = (path, opts = {}) => L.tileLayer(`${ESRI}/${path}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 20, attribution: ESRI_ATTR, ...opts });
const withLabels = (base, labels) => L.layerGroup([esri(base, { maxNativeZoom: 16 }), esri(labels, { maxNativeZoom: 16, pane: 'labels' })]);
map.createPane('labels');
map.getPane('labels').style.zIndex = 450;
map.getPane('labels').style.pointerEvents = 'none';
const BASEMAPS = {
  'Light gray': withLabels('Canvas/World_Light_Gray_Base', 'Canvas/World_Light_Gray_Reference'),
  'Dark gray': withLabels('Canvas/World_Dark_Gray_Base', 'Canvas/World_Dark_Gray_Reference'),
  Streets: esri('World_Street_Map', { maxNativeZoom: 19 }),
  Imagery: esri('World_Imagery', { maxNativeZoom: 19, attribution: `${ESRI_ATTR} | Imagery: Esri, Maxar, Earthstar Geographics` }),
};
let basemapName = dark ? 'Dark gray' : 'Light gray';
try {
  const saved = localStorage.getItem('sb79-basemap');
  if (saved && BASEMAPS[saved]) basemapName = saved;
} catch { /* storage unavailable */ }
BASEMAPS[basemapName].addTo(map);
L.control.layers(BASEMAPS, null, { position: 'topright', collapsed: true }).addTo(map);
map.on('baselayerchange', (e) => {
  try { localStorage.setItem('sb79-basemap', e.name); } catch { /* ignore */ }
});

const store = new ZoneStore(data.sources);
const zoneGroups = new Map(); // mpoId -> layer
const stopGroups = new Map();
let parcelGroup = null;
let highlight = null;
let currentParcels = [];
let viewToken = 0;

const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

function bboxOf(m) {
  const b = m.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

async function refreshZones() {
  let zoneErrors = 0;
  const bbox = bboxOf(map);
  const mpos = store.mposInView(bbox);
  await Promise.all(mpos.map(async (mpo) => {
    if (!zoneGroups.has(mpo.id)) {
      zoneGroups.set(mpo.id, 'loading');
      setStatus(`Loading ${mpo.id.toUpperCase()} TOD zones…`, 'zones');
      try {
        const feats = await store.loadZones(mpo);
        const layer = zoneLayer(L, feats).addTo(map);
        layer.bringToBack();
        zoneGroups.set(mpo.id, layer);
      } catch (e) {
        zoneGroups.delete(mpo.id);
        zoneErrors++;
        setStatus(`${mpo.name}: ${e.message}`, 'zones');
        return;
      }
    }
    if (map.getZoom() >= STOPS_MIN_ZOOM && $('tog-stops').checked && !stopGroups.has(mpo.id)) {
      stopGroups.set(mpo.id, 'loading');
      try {
        stopGroups.set(mpo.id, stopsLayer(L, mpo, await store.loadStops(mpo)));
      } catch {
        stopGroups.delete(mpo.id);
      }
    }
  }));
  for (const [, layer] of stopGroups) {
    if (layer === 'loading') continue;
    const show = map.getZoom() >= STOPS_MIN_ZOOM && $('tog-stops').checked;
    if (show && !map.hasLayer(layer)) layer.addTo(map);
    if (!show && map.hasLayer(layer)) map.removeLayer(layer);
  }
  if (!zoneErrors) setStatus('', 'zones');
}

let fireGroup = null;
let fireToken = 0;
/** Fire hazard overlay (State Fire Marshal), generalised to roughly one screen pixel. */
let fireArea = null;
async function refreshFire({ force = false } = {}) {
  const token = ++fireToken;
  const zoom = map.getZoom();
  if (!$('tog-fire').checked || zoom < FIRE_MIN_ZOOM) {
    if (fireGroup) map.removeLayer(fireGroup);
    fireGroup = fireArea = null;
    return;
  }
  const view = bboxOf(map);
  if (!force && fireArea && fireArea.zoom === zoom && contains(fireArea.bbox, view)) return;
  const mx = (view[2] - view[0]) * 0.25;
  const my = (view[3] - view[1]) * 0.25;
  const bbox = [view[0] - mx, view[1] - my, view[2] + mx, view[3] + my];
  const pxDeg = (view[2] - view[0]) / map.getSize().x;
  try {
    const fire = await fireInView(data.sources, bbox, zoom >= PARCEL_MIN_ZOOM ? undefined : pxDeg);
    if (token !== fireToken) return;
    if (fireGroup) map.removeLayer(fireGroup);
    fireArea = { bbox, zoom };
    fireGroup = fireLayer(L, fire).addTo(map);
  } catch (e) {
    setStatus(`Fire hazard zones: ${e.message}`, 'zones');
  }
}

const fireRules = fireRuleJurisdictions(data.registry, instrumentInForce);

// The last loaded parcel area. Zooming or panning inside it reuses the parcels
// instead of re-querying the county and re-classifying.
let loadedArea = null;
function clearParcels() {
  if (parcelGroup) map.removeLayer(parcelGroup);
  parcelGroup = null;
  currentParcels = [];
  loadedArea = null;
  $('dl-parcels').disabled = true;
}

async function refreshParcels({ force = false } = {}) {
  const token = ++viewToken;
  const isStale = () => token !== viewToken;
  const zoom = map.getZoom();
  if (zoom < PARCEL_MIN_ZOOM || !$('tog-parcels').checked) {
    clearParcels();
    setStatus(zoom >= 14 && zoom < PARCEL_MIN_ZOOM ? `Zoom in to level ${PARCEL_MIN_ZOOM} to load parcels` : '');
    return;
  }
  const view = bboxOf(map);
  if (!force && loadedArea && !loadedArea.truncated && contains(loadedArea.bbox, view)) return; // already have these parcels
  // Load a margin around the view so small pans don't trigger a reload.
  const mx = (view[2] - view[0]) * 0.2;
  const my = (view[3] - view[1]) * 0.2;
  const bbox = [view[0] - mx, view[1] - my, view[2] + mx, view[3] + my];
  setStatus('Loading parcels from the county assessor…');
  try {
    const errors = [];
    const soft = (label, p, fallback) => p.catch((e) => {
      errors.push(`${label}: ${e.message}`);
      return fallback;
    });
    // Everything for this view is fetched in parallel, once.
    const [loaded, zoneLists, fire, exclusions, cityNames] = await Promise.all([
      loadParcelsInView(data.sources, bbox),
      Promise.all(store.mposInView(bbox).map((m) => store.loadZones(m).catch(() => []))),
      soft('Fire hazard zones', fireInView(data.sources, bbox), null),
      $('tog-excl').checked ? loadExclusionsInView(data.registry, bbox) : [],
      fireRules.size ? soft('City limits', cityNamesInView(data.sources, bbox), []) : [],
    ]);
    if (isStale()) return;
    errors.push(...loaded.errors);
    const relevant = cityNames.filter((n) => fireRules.has(n));
    const fireCities = relevant.length ? await soft('City limits', cityShapesInView(data.sources, bbox, relevant), []) : [];
    if (isStale()) return;
    setStatus(`Classifying ${loaded.parcels.length.toLocaleString()} parcels…`);
    const stats = await annotateParcels(loaded.parcels, { zones: zoneLists.flat(), fire, exclusions, fireCities, fireRules, bbox, isStale });
    if (!stats || isStale()) return;
    if (parcelGroup) map.removeLayer(parcelGroup); // swap only when the new layer is ready
    currentParcels = loaded.parcels;
    loadedArea = { bbox, truncated: loaded.truncated };
    parcelGroup = parcelLayer(L, currentParcels, (e) => lookupPoint([e.latlng.lng, e.latlng.lat])).addTo(map);
    $('dl-parcels').disabled = !currentParcels.length;
    const parts = [`${currentParcels.length.toLocaleString()} parcels${loaded.truncated ? ' (truncated — zoom in)' : ''}`, `${stats.inZone.toLocaleString()} in a TOD zone`];
    if (stats.excluded) parts.push(`${stats.excluded.toLocaleString()} excluded locally`);
    if (stats.errors) parts.push(`${stats.errors} geometry errors`);
    setStatus(errors.length ? errors.join(' · ') : parts.join(' · '));
  } catch (e) {
    if (!isStale()) setStatus(`Parcels: ${e.message}`);
  }
}

let moveTimer;
map.on('moveend', () => {
  writeHash();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    refreshZones();
    refreshParcels();
    refreshFire();
  }, 350);
});
map.on('click', (e) => lookupPoint([e.latlng.lng, e.latlng.lat]));
['tog-parcels', 'tog-excl'].forEach((id) => $(id).addEventListener('change', () => refreshParcels({ force: true })));
$('tog-stops').addEventListener('change', refreshZones);
$('tog-fire').addEventListener('change', () => refreshFire({ force: true }));
$('dl-parcels').addEventListener('click', downloadParcels);

// ---------- lookup ----------
async function run(promise, label) {
  reportEl.innerHTML = renderLoading(label);
  try {
    const r = await promise;
    if (!r.ok) {
      reportEl.innerHTML = renderNotOk(r);
      return;
    }
    reportEl.innerHTML = renderReport(r, { standardsDoc: data.standards });
    showParcel(r.parcel.geometry);
  } catch (e) {
    reportEl.innerHTML = renderError(`A live source did not respond: ${e.message}${e.url ? ` (${new URL(e.url).host})` : ''}. Try again in a moment.`);
  }
}

function showParcel(geometry) {
  if (highlight) map.removeLayer(highlight);
  highlight = L.geoJSON(geometry, { style: { color: '#ff3d71', weight: 3, fillOpacity: 0 }, interactive: false }).addTo(map);
  const b = highlight.getBounds();
  if (!map.getBounds().contains(b) || map.getZoom() < 16) map.fitBounds(b, { maxZoom: 18, padding: [40, 40] });
}

function lookupPoint([lon, lat]) {
  setQuery({ pt: `${lon.toFixed(6)},${lat.toFixed(6)}` });
  run(reportForPoint(data, [lon, lat]), 'Querying parcel, TOD zones, and local instruments…');
}

// ---------- search: suggestions while typing, confident matches only ----------
const qEl = $('q');
const listEl = $('suggestions');
let suggestions = [];
let active = -1;
let suggestTimer;
let suggestToken = 0;
const center = () => [map.getCenter().lng, map.getCenter().lat];

function showSuggestions(items) {
  suggestions = items;
  active = -1;
  listEl.innerHTML = items.map((x, i) => `<li role="option" id="sug-${i}" data-i="${i}">${x.text.replace(/, USA$/, '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</li>`).join('');
  listEl.hidden = !items.length;
  qEl.setAttribute('aria-expanded', String(!!items.length));
}
function highlight(i) {
  active = (i + suggestions.length) % suggestions.length;
  [...listEl.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
  qEl.setAttribute('aria-activedescendant', `sug-${active}`);
}
function lookupAddress(text, magicKey) {
  showSuggestions([]);
  qEl.value = text.replace(/, USA$/, '');
  setQuery({ q: qEl.value });
  run(reportForAddress(data, text, { magicKey, location: center() }), `Geocoding “${qEl.value}” and querying live sources…`);
}

qEl.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const text = qEl.value.trim();
  if (text.length < 3) return showSuggestions([]);
  suggestTimer = setTimeout(async () => {
    const token = ++suggestToken;
    const items = await suggest(data.sources, text, { location: center() }).catch(() => []);
    if (token === suggestToken && qEl.value.trim() === text) showSuggestions(items);
  }, 220);
});
qEl.addEventListener('keydown', (e) => {
  if (listEl.hidden || !suggestions.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
  else if (e.key === 'Escape') showSuggestions([]);
  else if (e.key === 'Enter' && active >= 0) {
    e.preventDefault();
    lookupAddress(suggestions[active].text, suggestions[active].magicKey);
  }
});
listEl.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  const x = suggestions[Number(li.dataset.i)];
  lookupAddress(x.text, x.magicKey);
});
qEl.addEventListener('blur', () => setTimeout(() => showSuggestions([]), 150));

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qEl.value.trim();
  if (!q) return;
  showSuggestions([]);
  setQuery({ q });
  run(reportForAddress(data, q, { location: center() }), `Geocoding “${q}” and querying live sources…`);
});

// "Did you mean" choices in a no-match result
reportEl.addEventListener('click', (e) => {
  const b = e.target.closest('.didyoumean button');
  if (b) lookupAddress(b.dataset.text, b.dataset.magic);
});

// ---------- downloads ----------
function save(name, type, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function downloadParcels() {
  const stamp = new Date().toISOString().slice(0, 10);
  const fc = {
    type: 'FeatureCollection',
    features: currentParcels.map((p) => ({
      type: 'Feature',
      geometry: p.geometry,
      properties: { county: p.properties.countyId, apn: p.properties.apn, address: p.properties.address, sb79_best_zone: p.properties._code, sb79_zones: p.properties._zones },
    })),
  };
  save(`sb79-parcels-${stamp}.geojson`, 'application/geo+json', JSON.stringify(fc));
  save(`sb79-parcels-${stamp}.csv`, 'text/csv', parcelsToCSV(currentParcels));
}

// ---------- URL state ----------
function parseHash() {
  const m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
  return m ? { z: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) } : null;
}
function writeHash() {
  const c = map.getCenter();
  history.replaceState(null, '', `${location.pathname}${location.search}#${map.getZoom()}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
}
function setQuery(params) {
  const u = new URL(location.href);
  u.search = new URLSearchParams(params).toString();
  history.replaceState(null, '', u);
}

const params = new URLSearchParams(location.search);
if (params.get('q')) {
  $('q').value = params.get('q');
  run(reportForAddress(data, params.get('q')), 'Querying live sources…');
} else if (params.get('pt')) {
  const [lon, lat] = params.get('pt').split(',').map(Number);
  if (Number.isFinite(lon) && Number.isFinite(lat)) run(reportForPoint(data, [lon, lat]), 'Querying live sources…');
}
refreshZones();
refreshParcels();
refreshFire();
