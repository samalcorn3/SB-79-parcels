// End-to-end parcel report: address/point -> parcel -> TOD zones -> local
// instruments -> governing standards. Every spatial question is answered by a
// live query against the publisher's server.
import * as turf from '@turf/turf';
import { getJSON, queryIntersecting, toEsriGeometry } from './arcgis.js';
import { readSpec, getField } from './spec.js';
import { normalizeZone, dedupeZones, applyPopulationRule } from './zones.js';
import { computeStandards, projectRequirements } from './standards.js';
import { findJurisdiction, determineRegime, summarizeInstruments } from './policy.js';
import { parcelsAtPoint } from './parcels.js';
import { fireForParcel, fireCriterionStatus } from './fire.js';
import { ab2011ForParcel } from './ab2011.js';
import { siteExclusionsForParcel, exclusionsFor } from './exclusions.js';

const SQFT_PER_SQM = 10.7639;
const FEET_PER_MILE = 5280;

const CA_EXTENT = '-124.5,32.4,-114.0,42.1';
// Geocoder match types that identify an actual address (not a place name or a whole street).
const ADDRESS_TYPES = new Set(['PointAddress', 'StreetAddress', 'StreetAddressExt', 'Subaddress']);

export async function geocode(sources, text, { magicKey, location } = {}) {
  const json = await getJSON(`${sources.geocoder.url}/findAddressCandidates`, {
    SingleLine: text,
    magicKey,
    location: location ? location.join(',') : undefined,
    outFields: 'Match_addr,Addr_type,City,Subregion,Region',
    maxLocations: 5,
    countryCode: 'USA',
    searchExtent: CA_EXTENT,
    f: 'json',
  });
  return (json.candidates || [])
    .filter((c) => c.attributes?.Region === 'California' || /, California|, CA\b/.test(c.address))
    .map((c) => ({ label: c.address, lon: c.location.x, lat: c.location.y, score: c.score, type: c.attributes?.Addr_type, county: c.attributes?.Subregion, city: c.attributes?.City }));
}

/** Address suggestions while typing (Esri /suggest), biased toward `location`. */
export async function suggest(sources, text, { location, max = 6 } = {}) {
  if (!text || text.trim().length < 3) return [];
  const json = await getJSON(`${sources.geocoder.url}/suggest`, {
    text,
    category: 'Address,Postal',
    countryCode: 'USA',
    searchExtent: CA_EXTENT,
    location: location ? location.join(',') : undefined,
    maxSuggestions: max,
    f: 'json',
  }, { retries: 0, timeoutMs: 8000 });
  return (json.suggestions || []).filter((x) => !x.isCollection && /, CA\b/.test(x.text)).map((x) => ({ text: x.text, magicKey: x.magicKey }));
}

/**
 * Is a geocoder candidate a confident match for what the user typed? If the
 * input starts with a house number, only a real address match counts (a
 * place name or a whole street does not), and the score must be at least 90.
 */
export function acceptableCandidate(c, text) {
  if (!c || c.score < 90) return false;
  return /^\s*\d+/.test(text) ? ADDRESS_TYPES.has(c.type) : true;
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

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

export const FIRE_CRITERIA = ['vhfhsz', 'vhfhsz-or-sra'];

/** Coverage for instruments defined by statutory criteria we can compute (fire hazard). */
export function criteriaCoverage(inst, fire) {
  const c = inst.coverage;
  const criterion = c.criteria.find((x) => FIRE_CRITERIA.includes(x));
  if (!criterion) return { covered: c.complete ? false : null };
  if (fire == null) return { covered: null, reason: 'Fire-hazard check unavailable' };
  const parts = [];
  if (fire.vhfhsz.hit) parts.push(`${pct(fire.vhfhsz.share)} of parcel in a Very High Fire Hazard Severity Zone`);
  if (fire.sra.hit && criterion === 'vhfhsz-or-sra') parts.push(`${pct(fire.sra.share)} of parcel in the State Responsibility Area`);
  const st = fireCriterionStatus(fire, criterion);
  if (st === 'within') return { covered: true, reason: `${parts.join('; ')} (State Fire Marshal maps)` };
  if (st === 'partial') {
    return {
      covered: null,
      reason: `Parcel is only partly in a fire zone (${parts.join('; ')}). Neither the statute nor this ordinance says whether a partly covered site is “within” the zone.`,
    };
  }
  return { covered: c.complete ? false : null };
}

/** Which reason fields are set on a coverage-layer row. Values: label (field == 1) or { equals, label }. */
export function coverageReasons(row, reasonFields) {
  return Object.entries(reasonFields)
    .filter(([field, spec]) => {
      const v = getField(row, field);
      return typeof spec === 'string' ? Number(v) === 1 : v != null && String(v) === String(spec.equals);
    })
    .map(([, spec]) => (typeof spec === 'string' ? spec : spec.label))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('; ');
}

async function coverageFor(jurisdiction, interiorPoint, fire) {
  const out = {};
  if (!jurisdiction) return out;
  for (const inst of jurisdiction.instruments) {
    if (inst.coverage?.type === 'criteria') out[inst.id] = criteriaCoverage(inst, fire);
  }
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
          if (c.reasonFields) reason = coverageReasons(r, c.reasonFields);
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
  const [city, zonesRaw, stops, fire] = await Promise.all([
    cityAtPoint(sources, interior.coordinates),
    zonesForParcel(mpo, parcel.geometry).catch((e) => {
      errors.push(`TOD zones (${mpo.name}): ${e.message}`);
      return null;
    }),
    nearbyStops(mpo, parcel.geometry).catch((e) => {
      errors.push(`Nearby stops: ${e.message}`);
      return [];
    }),
    fireForParcel(sources, parcel).catch((e) => {
      errors.push(`Fire hazard zones (State Fire Marshal): ${e.message}`);
      return null;
    }),
  ]);

  const { zones, removed } = applyPopulationRule(zonesRaw || [], city?.population, standards.halfMileMinPopulation);
  const jurisdiction = city ? findJurisdiction(registry, city.name) : null;
  const coverage = await coverageFor(jurisdiction, interior, fire);
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
    fire,
    regime,
    instrumentSummary: summarizeInstruments(regime),
    standards: std && { ...std, lot: projectRequirements(standards, std, lotSqFt) },
    zoning,
    ab2011Context: { parcel, countyId: county.config.id, city, fire, zones, zoning, lotSqFt },
    provisions: standards.provisions,
    registryReviewed: registry.lastReviewed,
    errors,
  };
}

export async function reportForAddress(data, text, { magicKey, location } = {}) {
  const candidates = await geocode(data.sources, text, { magicKey, location });
  // A suggestion the user picked (magicKey) is trusted; free text must match confidently.
  const best = magicKey ? candidates[0] : candidates.find((c) => acceptableCandidate(c, text));
  if (!best) {
    const suggestions = await suggest(data.sources, text, { location }).catch(() => []);
    return {
      ok: false,
      reason: 'ambiguous',
      message: suggestions.length
        ? `No exact address match for “${text}”. Did you mean:`
        : `No California street address matched “${text}”. Try including the street type and city (e.g. “St, Los Angeles”).`,
      suggestions,
      candidates,
    };
  }
  const report = await reportForPoint(data, [best.lon, best.lat], { geocoded: { ...best, query: text } });
  return { ...report, candidates };
}

/** § 65913.4(a)(6) site exclusions for a finished report (shared by SB 79's streamlined path and AB 2011). */
export async function exclusionsForReport(data, report) {
  const c = report.ab2011Context;
  if (!c) return null;
  return siteExclusionsForParcel(data, { parcel: c.parcel, fire: c.fire }).catch((e) => ({ error: e.message }));
}

/** AB 2011 for a finished report. Kept separate so the SB 79 report can render first. */
export async function ab2011ForReport(data, report, exclusions) {
  const c = report.ab2011Context;
  if (!c) return null;
  const county = data.sources.counties.find((x) => x.id === c.countyId);
  const ex = await (exclusions ?? exclusionsForReport(data, report));
  return ab2011ForParcel(data, { ...c, county, exclusions: ex && !ex.error ? exclusionsFor('ab2011', ex) : null }).catch((e) => ({ error: e.message }));
}
