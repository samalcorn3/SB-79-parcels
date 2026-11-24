// County parcel adapters: one interface over ArcGIS and Socrata publishers.
// A county may declare a `fallback` source, used if the primary is unreachable.
import { queryIntersecting, queryGeoJSONInBBox, toEsriGeometry } from './arcgis.js';
import { socrataAtPoint, socrataInBBox } from './socrata.js';
import { getField, joinFields } from './spec.js';

export function normalizeParcel(county, feature, src = county.parcels) {
  const p = feature.properties || {};
  const f = src.fields;
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      countyId: county.id,
      id: String(getField(p, f.id) ?? getField(p, f.apn) ?? ''),
      apn: getField(p, f.apn) ? String(getField(p, f.apn)).trim() : null,
      address: joinFields(p, f.address) || null,
      use: f.use ? getField(p, f.use) ?? null : null,
      zoning: f.zoning ? getField(p, f.zoning) ?? null : null,
      zoningDescription: f.zoningDescription ? getField(p, f.zoningDescription) ?? null : null,
      publisher: src.publisher,
      sourceUrl: src.url,
      raw: p,
    },
  };
}

async function withFallback(county, fn) {
  try {
    return await fn(county.parcels);
  } catch (err) {
    if (!county.parcels.fallback) throw err;
    return fn(county.parcels.fallback);
  }
}

export async function parcelsAtPoint(county, [lon, lat]) {
  return withFallback(county, async (src) => {
    const feats =
      src.type === 'socrata'
        ? await socrataAtPoint(src, [lon, lat])
        : await queryIntersecting(src.url, toEsriGeometry({ type: 'Point', coordinates: [lon, lat] }), { returnGeometry: true, where: src.where || '1=1' });
    return feats.filter((f) => f.geometry).map((f) => normalizeParcel(county, f, src));
  });
}

export async function parcelsInBBox(county, bbox, { maxFeatures = 3000, withLandUse = false } = {}) {
  return withFallback(county, async (src) => {
    const outFields = [...Object.values(src.fields).flat(), ...(withLandUse && src.landUse ? Object.values(src.landUse.fields).flat() : [])];
    const res =
      src.type === 'socrata'
        ? await socrataInBBox(src, bbox, { maxFeatures })
        : await queryGeoJSONInBBox(src.url, bbox, { where: src.where || '1=1', pageSize: src.maxRecordCount || 1000, maxFeatures, outFields: [...new Set(outFields)] });
    return { features: res.features.filter((f) => f.geometry).map((f) => normalizeParcel(county, f, src)), truncated: res.truncated };
  });
}
