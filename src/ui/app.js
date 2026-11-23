// App wiring: map, search, click-to-lookup, live layers.
/* global L */
import { reportForAddress, reportForPoint, cityAtPoint } from '../lib/lookup.js';
import { findJurisdiction, instrumentInForce } from '../lib/policy.js';
import { renderReport, renderLoading, renderError, renderNotOk } from './report.js';
import {
  ZoneStore, classifyParcels, zoneLayer, stopsLayer, parcelLayer,
  loadParcelsInView, loadExclusionsInView, exclusionLayer, parcelsToCSV,
  fireInView, fireLayer, applyFire,
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
let exclusionGroup = null;
let highlight = null;
let currentParcels = [];
let viewToken = 0;

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
async function refreshFire() {
  const token = ++fireToken;
  if (fireGroup) map.removeLayer(fireGroup);
  fireGroup = null;
  if (!$('tog-fire').checked || map.getZoom() < FIRE_MIN_ZOOM) return;
  const bbox = bboxOf(map);
  const pxDeg = (bbox[2] - bbox[0]) / map.getSize().x;
  try {
    const fire = await fireInView(data.sources, bbox, map.getZoom() >= PARCEL_MIN_ZOOM ? undefined : pxDeg);
    if (token !== fireToken) return;
    fireGroup = fireLayer(L, fire).addTo(map);
  } catch (e) {
    setStatus(`Fire hazard zones: ${e.message}`, 'zones');
  }
}

async function refreshParcels() {
  const token = ++viewToken;
  const zoom = map.getZoom();
  if (parcelGroup) map.removeLayer(parcelGroup);
  if (exclusionGroup) map.removeLayer(exclusionGroup);
  parcelGroup = exclusionGroup = null;
  currentParcels = [];
  $('dl-parcels').disabled = true;
  setStatus('');
  if (zoom < PARCEL_MIN_ZOOM) {
    if (zoom >= 14) setStatus(`Zoom in to level ${PARCEL_MIN_ZOOM} to load parcels`);
    return;
  }
  const bbox = bboxOf(map);
  if ($('tog-excl').checked) {
    loadExclusionsInView(data.registry, bbox).then((feats) => {
      if (token !== viewToken || !feats.length) return;
      exclusionGroup = exclusionLayer(L, feats).addTo(map);
    });
  }
  if (!$('tog-parcels').checked) return;
  setStatus('Loading parcels from the county assessor…');
  try {
    const [{ parcels, errors, truncated }, zoneLists, fire] = await Promise.all([
      loadParcelsInView(data.sources, bbox),
      Promise.all(store.mposInView(bbox).map((m) => store.loadZones(m).catch(() => []))),
      fireInView(data.sources, bbox).catch((e) => {
        errors.push(`Fire hazard zones: ${e.message}`);
        return null;
      }),
    ]);
    if (token !== viewToken) return;
    const { errors: geomErrors } = classifyParcels(parcels, zoneLists.flat());
    let excluded = 0;
    if (fire) {
      excluded = await applyFire(parcels, fire, { sources: data.sources, registry: data.registry, cityAt: cityAtPoint, instrumentInForce, findJurisdiction });
      if (token !== viewToken) return;
    }
    currentParcels = parcels;
    parcelGroup = parcelLayer(L, parcels, (e) => lookupPoint([e.latlng.lng, e.latlng.lat])).addTo(map);
    $('dl-parcels').disabled = !parcels.length;
    const inZone = parcels.filter((p) => p.properties._code !== 'none').length;
    const parts = [`${parcels.length.toLocaleString()} parcels${truncated ? ' (truncated — zoom in)' : ''}`, `${inZone.toLocaleString()} in a TOD zone`];
    if (excluded) parts.push(`${excluded.toLocaleString()} excluded by a local fire-zone ordinance`);
    if (geomErrors) parts.push(`${geomErrors} geometry errors`);
    setStatus(errors.length ? errors.join(' · ') : parts.join(' · '));
  } catch (e) {
    if (token === viewToken) setStatus(`Parcels: ${e.message}`);
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
['tog-parcels', 'tog-excl'].forEach((id) => $(id).addEventListener('change', refreshParcels));
$('tog-stops').addEventListener('change', refreshZones);
$('tog-fire').addEventListener('change', refreshFire);
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

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  setQuery({ q });
  run(reportForAddress(data, q), `Geocoding “${q}” and querying live sources…`);
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
