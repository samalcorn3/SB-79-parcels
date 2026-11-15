// End-to-end parcel report: address/point -> parcel -> TOD zones -> local
// instruments -> governing standards. Every spatial question is answered by a
// live query against the publisher's server.
import * as turf from '@turf/turf';
import { getJSON, queryIntersecting, toEsriGeometry } from './arcgis.js';
import { readSpec, getField } from './spec.js';
import { normalizeZone, dedupeZones, applyPopulationRule } from './zones.js';
import { computeStandards, unitsForLot, floorAreaForLot } from './standards.js';
import { findJurisdiction, determineRegime, summarizeInstruments } from './policy.js';
import { parcelsAtPoint } from './parcels.js';

const SQFT_PER_SQM = 10.7639;
const FEET_PER_MILE = 5280;

export async function geocode(sources, text) {
  const json = await getJSON(`${sources.geocoder.url}/findAddressCandidates`, {
    SingleLine: text,
    outFields: 'Match_addr,Addr_type,City,Subregion,Region',
    maxLocations: 5,
    countryCode: 'USA',
    searchExtent: '-124.5,32.4,-114.0,42.1',
    f: 'json',
  });
  return (json.candidates || [])
    .filter((c) => c.attributes?.Region === 'California' || /, California|, CA\b/.test(c.address))
    .map((c) => ({ label: c.address, lon: c.location.x, lat: c.location.y, score: c.score, type: c.attributes?.Addr_type, county: c.attributes?.Subregion, city: c.attributes?.City }));
}

export async function countyAtPoint(sources, [lon, lat]) {
  const b = sources.boundaries.counties;
  const rows = await queryIntersecting(b.url, toEsriGeometry({ type: 'Point', coordinates: [lon, lat] }), { outFields: [b.fields.name] });
  const name = rows[0] ? getField(rows[0], b.fields.name) : null;
  return { name, config: matchCounty(sources, name) };
}

export function matchCounty(sources, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return sources.counties.find((c) => c.match.some((m) => m.toLowerCase() === n)) || null;
}

export async function cityAtPoint(sources, [lon, lat]) {
  const b = sources.boundaries.cities;
  const rows = await queryIntersecting(b.url, toEsriGeometry({ type: 'Point', coordinates: [lon, lat] }), { outFields: Object.values(b.fields) });
  if (!rows[0]) return null;
  const pop = getField(rows[0], b.fields.population);
  return { name: getField(rows[0], b.fields.name), county: getField(rows[0], b.fields.county), population: pop == null ? null : Number(pop) };
}

/** Zones intersecting the parcel, asked of the MPO's own server. */
export async function zonesForParcel(mpo, parcelGeometry) {
  const geo = toEsriGeometry(parcelGeometry);
  const hits = [];
  await Promise.all(
    mpo.zoneLayers.map(async (layer) => {
      const rows = await queryIntersecting(layer.url, geo, { outFields: layer.outFields || ['*'] });
      for (const r of rows) hits.push(normalizeZone(layer, r, mpo.id));
    }),
  );
  if (mpo.adjacencyFromStops) {
    const stops = await queryIntersecting(mpo.stops.url, geo, { outFields: ['*'], distanceFeet: mpo.adjacencyFromStops.distanceFeet });
    for (const s of stops) {
      const tier = Number(readSpec(mpo.stops.tier, s));
      if ([1, 2].includes(tier)) hits.push({ mpo: mpo.id, tier, band: 'adjacent', label: `Tier ${tier} – within 200 ft of stop (computed)`, flags: ['computed-adjacency'] });
    }
  }
  return dedupeZones(hits);
}

export async function nearbyStops(mpo, parcelGeometry, radiusFeet = FEET_PER_MILE / 2) {
  const feats = await queryIntersecting(mpo.stops.url, toEsriGeometry(parcelGeometry), { returnGeometry: true, distanceFeet: radiusFeet });
  const ring = turf.polygonToLine(turf.feature(parcelGeometry));
  const lines = ring.type === 'FeatureCollection' ? ring.features : [ring];
  return feats
    .filter((f) => f.geometry?.type === 'Point')
    .map((f) => {
      const pt = f;
      const inside = turf.booleanPointInPolygon(pt, turf.feature(parcelGeometry));
      const ft = inside ? 0 : Math.min(...lines.map((l) => turf.pointToLineDistance(pt, l, { units: 'feet' })));
      return {
        name: readSpec(mpo.stops.name, f.properties) || 'TOD stop',
        tier: Number(readSpec(mpo.stops.tier, f.properties)) || null,
        mode: readSpec(mpo.stops.mode, f.properties) || null,
        line: readSpec(mpo.stops.line, f.properties) || null,
        distanceFt: Math.round(ft),
        coordinates: f.geometry.coordinates,
      };
    })
    .sort((a, b) => a.distanceFt - b.distanceFt);
}

function pickParcel(parcels) {
  if (!parcels.length) return null;
  const withApn = parcels.filter((p) => p.properties.apn);
  const pool = withApn.length ? withApn : parcels;
  return pool.reduce((best, p) => (turf.area(p) > turf.area(best) ? p : best), pool[0]);
}

async function coverageFor(jurisdiction, interiorPoint) {
  const out = {};
  if (!jurisdiction) return out;
  await Promise.all(
    jurisdiction.instruments
      .filter((i) => i.coverage?.type === 'arcgis')
      .map(async (inst) => {
        const c = inst.coverage;
        try {
          const rows = await queryIntersecting(c.url, toEsriGeometry(interiorPoint), { where: c.where || '1=1', outFields: ['*'] });
          if (!rows.length) {
            out[inst.id] = { covered: false };
            return;
          }
          const r = rows[0];
          let reason = c.reasonField ? getField(r, c.reasonField) : undefined;
          if (c.reasonFields) {
            reason = Object.entries(c.reasonFields)
              .filter(([field]) => Number(getField(r, field)) === 1)
              .map(([, label]) => label)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join('; ');
          }
          out[inst.id] = { covered: true, reason: reason || undefined };
        } catch (err) {
          out[inst.id] = { covered: null, error: err.message };
        }
      }),
  );
  return out;
}

async function localZoning(county, parcel, cityName, interiorPoint) {
  if (parcel.properties.zoning) {
    return { code: parcel.properties.zoning, description: parcel.properties.zoningDescription, source: parcel.properties.publisher };
  }
  const z = county.zoning;
  if (!z) return null;
  const applies = z.appliesTo === 'unincorporated' ? !cityName : z.appliesTo?.toLowerCase() === cityName?.toLowerCase();
  if (!applies) return null;
  try {
    const rows = await queryIntersecting(z.url, toEsriGeometry(interiorPoint), { outFields: Object.values(z.fields) });
    if (!rows[0]) return null;
    return { code: getField(rows[0], z.fields.code), description: z.fields.description ? getField(rows[0], z.fields.description) : null, source: z.publisher };
  } catch {
    return null;
  }
}

/**
 * Build the full report for a WGS84 point.
 * @param {{sources, standards, registry}} data  the three data/*.json documents
 */
export async function reportForPoint(data, [lon, lat], { geocoded } = {}) {
  const { sources, standards, registry } = data;
  const errors = [];

  const county = await countyAtPoint(sources, [lon, lat]);
  if (!county.config) {
    return { ok: false, reason: 'out-of-coverage', message: `${county.name || 'This location'} is not one of the counties this tool covers (${sources.counties.map((c) => c.name).join(', ')}).`, county: county.name };
  }
  const mpo = sources.mpos.find((m) => m.id === county.config.mpo);

  const parcel = pickParcel(await parcelsAtPoint(county.config, [lon, lat]));
  if (!parcel) {
    return { ok: false, reason: 'no-parcel', message: 'No assessor parcel at this point (it may be a street or other right-of-way). Try clicking inside a lot.', county: county.config.name };
  }

  const interior = turf.pointOnFeature(parcel).geometry;
  const [city, zonesRaw, stops] = await Promise.all([
    cityAtPoint(sources, interior.coordinates),
    zonesForParcel(mpo, parcel.geometry).catch((e) => {
      errors.push(`TOD zones (${mpo.name}): ${e.message}`);
      return null;
    }),
    nearbyStops(mpo, parcel.geometry).catch((e) => {
      errors.push(`Nearby stops: ${e.message}`);
      return [];
    }),
  ]);

  const { zones, removed } = applyPopulationRule(zonesRaw || [], city?.population, standards.halfMileMinPopulation);
  const jurisdiction = city ? findJurisdiction(registry, city.name) : null;
  const coverage = await coverageFor(jurisdiction, interior);
  const regime = zonesRaw == null
    ? { regime: 'error', headline: 'Could not reach the MPO’s TOD-zone service', detail: errors.join(' '), instruments: [], notes: [] }
    : determineRegime({ zones, county: county.config, jurisdiction, cityName: city?.name || null, coverage });
  const std = computeStandards(standards, zones);
  const lotSqFt = Math.round(turf.area(parcel) * SQFT_PER_SQM);
  const zoning = await localZoning(county.config, parcel, city?.name, interior);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    input: { lon, lat, geocoded },
    county: { id: county.config.id, name: county.config.name, sb79Status: county.config.sb79Status, statusNote: county.config.statusNote },
    mpo: { id: mpo.id, name: mpo.name, mapPage: mpo.mapPage, draft: !!mpo.draft, notes: mpo.notes || [] },
    parcel: {
      ...parcel.properties,
      raw: undefined,
      lotSqFt,
      geometry: parcel.geometry,
      publisher: parcel.properties.publisher,
      sourceUrl: parcel.properties.sourceUrl,
      stale: !!county.config.parcels.stale,
      sourceNotes: county.config.parcels.notes || [],
    },
    jurisdiction: city ? { name: city.name, population: city.population, incorporated: true } : { name: `Unincorporated ${county.config.name}`, incorporated: false },
    zones,
    zonesRemovedByPopulation: removed,
    nearbyStops: stops.slice(0, 12),
    regime,
    instrumentSummary: summarizeInstruments(regime),
    standards: std && {
      ...std,
      lot: {
        units: unitsForLot(std.max.densityDuAc.value, lotSqFt),
        floorAreaSqFt: floorAreaForLot(std.max.far.value, lotSqFt),
      },
    },
    zoning,
    provisions: standards.provisions,
    registryReviewed: registry.lastReviewed,
    errors,
  };
}

export async function reportForAddress(data, text) {
  const candidates = await geocode(data.sources, text);
  if (!candidates.length) return { ok: false, reason: 'not-found', message: `No California address match for “${text}”.` };
  const best = candidates[0];
  const report = await reportForPoint(data, [best.lon, best.lat], { geocoded: best });
  return { ...report, candidates };
}
