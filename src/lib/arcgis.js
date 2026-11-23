// Minimal ArcGIS REST client (FeatureServer / MapServer layers).
// Works in browsers and Node 18+ (global fetch).

const DEFAULT_TIMEOUT_MS = 30000;

export class SourceError extends Error {
  constructor(message, { url, cause } = {}) {
    super(message);
    this.name = 'SourceError';
    this.url = url;
    this.cause = cause;
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET (or POST when the query string is long) a JSON resource with retries.
 * Some county servers sit behind bot filters that occasionally return an HTML
 * challenge; those are retried with backoff and then reported clearly.
 */
export async function getJSON(url, params = {}, { retries = 2, timeoutMs } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const qs = body.toString();
  const usePost = qs.length > 1800;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = usePost
        ? await fetchWithTimeout(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, timeoutMs)
        : await fetchWithTimeout(qs ? `${url}?${qs}` : url, {}, timeoutMs);
      const text = await res.text();
      if (!res.ok) throw new SourceError(`HTTP ${res.status}`, { url });
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new SourceError('Server returned a non-JSON response (possibly a bot-protection page)', { url });
      }
      if (json.error) throw new SourceError(`${json.error.message || 'ArcGIS error'} ${(json.error.details || []).join(' ')}`.trim(), { url });
      return json;
    } catch (err) {
      lastErr = err instanceof SourceError ? err : new SourceError(err.name === 'AbortError' ? 'Request timed out' : err.message, { url, cause: err });
      if (attempt < retries) await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** GeoJSON geometry (WGS84) -> Esri JSON geometry. */
export function toEsriGeometry(geom) {
  const sr = { wkid: 4326 };
  switch (geom.type) {
    case 'Point':
      return { geometryType: 'esriGeometryPoint', geometry: { x: geom.coordinates[0], y: geom.coordinates[1], spatialReference: sr } };
    case 'Polygon':
      return { geometryType: 'esriGeometryPolygon', geometry: { rings: geom.coordinates, spatialReference: sr } };
    case 'MultiPolygon':
      return { geometryType: 'esriGeometryPolygon', geometry: { rings: geom.coordinates.flat(), spatialReference: sr } };
    default:
      throw new Error(`Unsupported geometry type ${geom.type}`);
  }
}

export function envelope([minX, minY, maxX, maxY]) {
  return { geometryType: 'esriGeometryEnvelope', geometry: { xmin: minX, ymin: minY, xmax: maxX, ymax: maxY, spatialReference: { wkid: 4326 } } };
}

/**
 * Features intersecting a geometry. Returns attribute objects (no geometry)
 * unless returnGeometry is set, in which case GeoJSON features are returned.
 */
export async function queryIntersecting(layerUrl, geo, { outFields = ['*'], where = '1=1', returnGeometry = false, distanceFeet, extra = {} } = {}) {
  const params = {
    where,
    geometry: geo.geometry,
    geometryType: geo.geometryType,
    inSR: 4326,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: outFields.join(','),
    returnGeometry,
    ...extra,
  };
  if (distanceFeet) {
    params.distance = distanceFeet;
    params.units = 'esriSRUnit_Foot';
  }
  if (returnGeometry) {
    Object.assign(params, { outSR: 4326, f: 'geojson', geometryPrecision: 7 });
    const json = await getJSON(`${layerUrl}/query`, params);
    return json.features || [];
  }
  params.f = 'json';
  const json = await getJSON(`${layerUrl}/query`, params);
  return (json.features || []).map((f) => f.attributes);
}

/** All features in a bbox as GeoJSON, following pagination up to maxFeatures. */
export async function queryGeoJSONInBBox(layerUrl, bbox, { outFields = ['*'], where = '1=1', pageSize = 1000, maxFeatures = 4000, precision = 6, maxAllowableOffset } = {}) {
  const env = envelope(bbox);
  const base = {
    where,
    geometry: env.geometry,
    geometryType: env.geometryType,
    inSR: 4326,
    spatialRel: 'esriSpatialRelIntersects',
  };
  const page = (offset) => getJSON(`${layerUrl}/query`, {
    ...base,
    outFields: outFields.join(','),
    returnGeometry: true,
    outSR: 4326,
    geometryPrecision: precision,
    maxAllowableOffset,
    resultOffset: offset,
    resultRecordCount: pageSize,
    f: 'geojson',
  });
  // First page and total count in parallel; then the remaining pages in parallel.
  const [first, count] = await Promise.all([
    page(0),
    getJSON(`${layerUrl}/query`, { ...base, returnCountOnly: true, f: 'json' }).then((r) => r.count).catch(() => null),
  ]);
  const out = [...(first.features || [])];
  const more = first.exceededTransferLimit || first.properties?.exceededTransferLimit;
  if (more && out.length) {
    const step = out.length;
    const total = Math.min(count ?? maxFeatures, maxFeatures);
    const offsets = [];
    for (let o = step; o < total; o += step) offsets.push(o);
    for (let k = 0; k < offsets.length; k += 4) {
      const pages = await Promise.all(offsets.slice(k, k + 4).map(page));
      for (const pg of pages) out.push(...(pg.features || []));
    }
  }
  const truncated = count != null ? count > maxFeatures : out.length >= maxFeatures;
  return { features: out.slice(0, maxFeatures), truncated };
}

/** Every feature of a (small) layer as GeoJSON, e.g. MPO TOD zones. */
export async function queryAllGeoJSON(layerUrl, { outFields = ['*'], where = '1=1', precision = 6, maxAllowableOffset } = {}) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const json = await getJSON(`${layerUrl}/query`, {
      where,
      outFields: outFields.join(','),
      returnGeometry: true,
      outSR: 4326,
      geometryPrecision: precision,
      maxAllowableOffset,
      resultOffset: offset,
      f: 'geojson',
    }, { timeoutMs: 90000 });
    const feats = json.features || [];
    out.push(...feats);
    const more = json.exceededTransferLimit || json.properties?.exceededTransferLimit;
    if (!more || feats.length === 0) break;
    offset += feats.length;
  }
  return out;
}

export async function layerInfo(layerUrl) {
  return getJSON(layerUrl, { f: 'json' });
}
