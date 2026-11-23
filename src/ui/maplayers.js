// Live map layers: MPO zones & stops, county parcels classified by zone,
// and published local exclusion layers. Everything is fetched from the
// publishers' servers for the current view; nothing is pre-processed.
import * as turf from '@turf/turf';
import { queryAllGeoJSON, queryGeoJSONInBBox, queryIntersecting, envelope } from '../lib/arcgis.js';
import { normalizeZone, dedupeZones, zoneCode } from '../lib/zones.js';
import { readSpec } from '../lib/spec.js';
import { parcelsInBBox } from '../lib/parcels.js';
import { fireStatus } from '../lib/fire.js';
import { matchCounty } from '../lib/lookup.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const ZONE_COLORS = () => ({
  'T1-adjacent': css('--t1-adj'), 'T1-quarter': css('--t1-q'), 'T1-half': css('--t1-h'),
  'T2-adjacent': css('--t2-adj'), 'T2-quarter': css('--t2-q'), 'T2-half': css('--t2-h'),
});
const DRAW_ORDER = ['T2-half', 'T1-half', 'T2-quarter', 'T1-quarter', 'T2-adjacent', 'T1-adjacent'];

const bboxesOverlap = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export class ZoneStore {
  constructor(sources) {
    this.sources = sources;
    this.zones = new Map(); // mpoId -> Promise<feature[]>
    this.stops = new Map();
  }

  mposInView(bbox) {
    return this.sources.mpos.filter((m) => bboxesOverlap(m.bbox, bbox));
  }

  loadZones(mpo) {
    if (!this.zones.has(mpo.id)) {
      this.zones.set(mpo.id, (async () => {
        const out = [];
        for (const layer of mpo.zoneLayers) {
          const feats = await queryAllGeoJSON(layer.url, { outFields: layer.outFields || ['*'], precision: 6 });
          for (const f of feats) {
            const z = normalizeZone(layer, f.properties, mpo.id);
            if (z && f.geometry) out.push({ ...f, properties: { _z: z, _code: zoneCode(z) } });
          }
        }
        if (mpo.adjacencyFromStops) {
          const stops = await this.loadStops(mpo);
          for (const s of stops) {
            const tier = Number(readSpec(mpo.stops.tier, s.properties));
            if (![1, 2].includes(tier)) continue;
            const z = { mpo: mpo.id, tier, band: 'adjacent', label: `Tier ${tier} – 200 ft (computed)`, flags: ['computed-adjacency'] };
            const buf = turf.buffer(s, mpo.adjacencyFromStops.distanceFeet, { units: 'feet', steps: 16 });
            out.push({ ...buf, properties: { _z: z, _code: zoneCode(z) } });
          }
        }
        // MPOs publish dissolved multipolygons (SCAG's Tier 2 · 200 ft layer has
        // 200+ parts). Split them so each part can be bbox-filtered on its own.
        const parts = [];
        for (const f of out) {
          turf.flattenEach(f, (part) => {
            if (part.geometry?.coordinates?.[0]?.length >= 4) parts.push({ ...part, properties: f.properties, bbox: turf.bbox(part) });
          });
        }
        return parts;
      })().catch((e) => {
        this.zones.delete(mpo.id);
        throw e;
      }));
    }
    return this.zones.get(mpo.id);
  }

  loadStops(mpo) {
    if (!this.stops.has(mpo.id)) {
      this.stops.set(mpo.id, queryAllGeoJSON(mpo.stops.url, { precision: 6 }).catch((e) => {
        this.stops.delete(mpo.id);
        throw e;
      }));
    }
    return this.stops.get(mpo.id);
  }
}

/**
 * Classify parcels against single-part zone polygons. A parcel is in a zone
 * when its polygon intersects the zone (§ 65912.157(b): distance from the
 * nearest parcel edge). Returns the number of geometry errors encountered so
 * the UI can report them instead of silently calling a parcel "not in a zone".
 */
export function classifyParcels(parcels, zoneFeatures) {
  let errors = 0;
  for (const p of parcels) {
    const pb = turf.bbox(p);
    const hits = [];
    for (const z of zoneFeatures) {
      if (!bboxesOverlap(pb, z.bbox || (z.bbox = turf.bbox(z)))) continue;
      try {
        if (turf.booleanIntersects(p, z)) hits.push(z.properties._z);
      } catch {
        errors++;
      }
    }
    const zones = dedupeZones(hits);
    p.properties._zones = zones;
    p.properties._code = zoneCode(zones[0]);
  }
  return { parcels, errors };
}

// ---------- fire hazard (CAL FIRE / State Fire Marshal) ----------

/** VHFHSZ (LRA) and SRA polygons in view. `offsetDeg` generalises geometry for display. */
export async function fireInView(sources, bbox, offsetDeg) {
  const cfg = sources.fireHazard;
  const get = (l) => queryGeoJSONInBBox(l.url, bbox, { where: l.where, outFields: ['OBJECTID'], maxFeatures: 2000, precision: 6, maxAllowableOffset: offsetDeg ?? 0.000005 })
    .then((r) => r.features.filter((f) => f.geometry).map((f) => ({ ...f, bbox: turf.bbox(f) })));
  const [vhfhsz, sra] = await Promise.all([get(cfg.vhfhsz), get(cfg.sra)]);
  return { vhfhsz, sra };
}

export function fireLayer(L, fire) {
  const style = { color: '#d7301f', weight: 1, opacity: 0.8, fillColor: '#d7301f', fillOpacity: 0.12, dashArray: null };
  return L.layerGroup([
    L.geoJSON(fire.vhfhsz, { interactive: false, style }),
    L.geoJSON(fire.sra, { interactive: false, style: { ...style, dashArray: '6 4', fillOpacity: 0.06 } }),
  ]);
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/** Split polygons into single parts, clip them to the bbox, and drop empty parts. */
export function clipToBBox(features, bbox) {
  const out = [];
  for (const f of features) {
    turf.flattenEach(f, (part) => {
      if (!bboxesOverlap(turf.bbox(part), bbox)) return;
      let c;
      try {
        c = turf.bboxClip(part, bbox);
      } catch {
        return;
      }
      const rings = (c.geometry?.coordinates || []).filter((r) => r.length >= 4);
      if (!rings.length) return;
      const poly = turf.polygon(rings, f.properties);
      out.push({ ...poly, bbox: turf.bbox(poly) });
    });
  }
  return out;
}

const firstContaining = (pt, polys) => polys.find((z) => pt[0] >= z.bbox[0] && pt[0] <= z.bbox[2] && pt[1] >= z.bbox[1] && pt[1] <= z.bbox[3] && turf.booleanPointInPolygon(pt, z));

/** Jurisdictions whose ordinance in force excludes fire-zone sites (§ 65912.161(b)(1)(D)). */
export function fireRuleJurisdictions(registry, instrumentInForce) {
  const out = new Map();
  for (const [name, j] of Object.entries(registry.jurisdictions)) {
    const inst = j.instruments.find((x) => x.coverage?.type === 'criteria' && x.coverage.criteria.includes('fire-hazard') && instrumentInForce(x).inForce);
    if (inst) out.set(name, inst);
  }
  return out;
}

/** City polygons in view, but only for the named cities, clipped to the view. */
export async function cityShapesInView(sources, bbox, names) {
  if (!names.length) return [];
  const b = sources.boundaries.cities;
  const where = `${b.fields.name} IN (${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')})`;
  const r = await queryGeoJSONInBBox(b.url, bbox, { where, outFields: [b.fields.name], maxAllowableOffset: 0.00001, maxFeatures: 50 });
  return clipToBBox(r.features.map((f) => ({ ...f, properties: { name: f.properties[b.fields.name] } })), bbox);
}

export async function cityNamesInView(sources, bbox) {
  const b = sources.boundaries.cities;
  const rows = await queryIntersecting(b.url, envelope(bbox), { outFields: [b.fields.name] });
  return rows.map((r) => r[b.fields.name]);
}

/**
 * Annotate parcels for the map in small batches so the page stays responsive:
 *   _zones/_code  TOD zones (§ 65912.157(b) nearest-edge test)
 *   _fire         share of parcel in a VHFHSZ / the SRA (State Fire Marshal)
 *   _excluded     covered by a published local exclusion layer, or by a city
 *                 fire-zone ordinance (§ 65912.161(b)(1)(D))
 * `isStale()` lets a newer map view cancel the work.
 */
export async function annotateParcels(parcels, { zones, fire, exclusions = [], fireCities = [], fireRules = new Map(), bbox, isStale = () => false, batch = 250 }) {
  // Clip to the extent of the parcels themselves (they can run past the view edge).
  const pb = parcels.length ? turf.bbox(turf.featureCollection(parcels)) : bbox;
  const work = [Math.min(pb[0], bbox[0]), Math.min(pb[1], bbox[1]), Math.max(pb[2], bbox[2]), Math.max(pb[3], bbox[3])];
  const fireParts = fire ? { vhfhsz: clipToBBox(fire.vhfhsz, work), sra: clipToBBox(fire.sra, work) } : null;
  // Zone parts can be large (½-mile rings at full precision); clip them to this view once.
  const zoneParts = clipToBBox(zones, work);
  const exclParts = exclusions.map((f) => ({ ...f, bbox: f.bbox || turf.bbox(f) }));
  const stats = { inZone: 0, excluded: 0, fire: 0, errors: 0 };
  for (let i = 0; i < parcels.length; i += batch) {
    if (isStale()) return null;
    const chunk = parcels.slice(i, i + batch);
    stats.errors += classifyParcels(chunk, zoneParts).errors;
    for (const p of chunk) {
      if (p.properties._code === 'none') continue;
      stats.inZone++;
      const c = turf.centroid(p).geometry.coordinates;
      const pt = turf.booleanPointInPolygon(c, p) ? c : turf.pointOnFeature(p).geometry.coordinates;
      const ex = exclParts.length && firstContaining(pt, exclParts);
      if (ex) {
        p.properties._excluded = { jurisdiction: ex.properties.jurisdiction, title: ex.properties.title };
        stats.excluded++;
      }
      if (!fireParts) continue;
      const st = fireStatus(p, fireParts);
      if (!st.qualifies) continue;
      p.properties._fire = st;
      stats.fire++;
      if (p.properties._excluded || !fireCities.length) continue;
      const city = firstContaining(pt, fireCities);
      const inst = city && fireRules.get(city.properties.name);
      if (inst) {
        p.properties._excluded = { jurisdiction: city.properties.name, title: inst.title };
        stats.excluded++;
      }
    }
    await yieldToUI();
  }
  return stats;
}

export function zoneLayer(L, features) {
  const colors = ZONE_COLORS();
  const sorted = [...features].sort((a, b) => DRAW_ORDER.indexOf(a.properties._code) - DRAW_ORDER.indexOf(b.properties._code));
  return L.geoJSON(sorted, {
    interactive: false,
    style: (f) => ({ color: colors[f.properties._code], weight: 1, opacity: 0.7, fillColor: colors[f.properties._code], fillOpacity: 0.22 }),
  });
}

export function stopsLayer(L, mpo, features) {
  const colors = ZONE_COLORS();
  return L.geoJSON(features, {
    pointToLayer: (f, latlng) => {
      const tier = Number(readSpec(mpo.stops.tier, f.properties));
      return L.circleMarker(latlng, { radius: 4, weight: 1.5, color: '#fff', fillColor: tier === 1 ? colors['T1-adjacent'] : colors['T2-adjacent'], fillOpacity: 1 });
    },
    onEachFeature: (f, layer) => {
      const name = readSpec(mpo.stops.name, f.properties) || 'TOD stop';
      const tier = readSpec(mpo.stops.tier, f.properties);
      const line = mpo.stops.line ? readSpec(mpo.stops.line, f.properties) : '';
      layer.bindTooltip(`${name}${line ? ` (${line})` : ''} — Tier ${tier}`);
    },
  });
}

export function parcelLayer(L, parcels, onClick) {
  const colors = ZONE_COLORS();
  return L.geoJSON(parcels, {
    style: (f) => {
      const c = colors[f.properties._code];
      if (f.properties._excluded) return { color: css('--excl') || '#d97706', weight: 1.3, opacity: 1, fillColor: '#7a7a7a', fillOpacity: 0.35 };
      return c
        ? { color: c, weight: 0.8, opacity: 0.9, fillColor: c, fillOpacity: 0.45 }
        : { color: '#888', weight: 0.5, opacity: 0.6, fillOpacity: 0.02 };
    },
    onEachFeature: (f, layer) => {
      const z = f.properties._zones?.[0];
      const band = { adjacent: '200 ft', quarter: '¼ mi', half: '½ mi' };
      const lines = [
        `${f.properties.apn || f.properties.id}${f.properties.address ? ` · ${f.properties.address}` : ''}`,
        z ? `Tier ${z.tier} · ${band[z.band]}` : 'Not in a TOD zone',
      ];
      const fire = f.properties._fire;
      if (fire?.vhfhsz.hit) lines.push(`Very high fire hazard zone (${Math.round(fire.vhfhsz.share * 100)}% of parcel)`);
      if (fire?.sra.hit) lines.push(`State Responsibility Area (${Math.round(fire.sra.share * 100)}% of parcel)`);
      if (f.properties._excluded) lines.push(`<b>Excluded</b> by ${f.properties._excluded.jurisdiction}: ${f.properties._excluded.title}`);
      layer.bindTooltip(lines.join('<br>'), { sticky: true });
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onClick(e, f);
      });
    },
  });
}

export async function countiesInView(sources, bbox) {
  const b = sources.boundaries.counties;
  const rows = await queryIntersecting(b.url, envelope(bbox), { outFields: [b.fields.name] });
  return rows.map((r) => matchCounty(sources, r[b.fields.name])).filter(Boolean);
}

export async function loadParcelsInView(sources, bbox) {
  const counties = await countiesInView(sources, bbox);
  const results = await Promise.allSettled(counties.map((c) => parcelsInBBox(c, bbox, { maxFeatures: 6000 })));
  const parcels = [];
  const errors = [];
  let truncated = false;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      parcels.push(...r.value.features);
      truncated ||= r.value.truncated;
    } else errors.push(`${counties[i].name} parcels: ${r.reason.message}`);
  });
  return { parcels, errors, truncated, counties };
}

export async function loadExclusionsInView(registry, bbox) {
  const tasks = [];
  for (const [name, j] of Object.entries(registry.jurisdictions)) {
    for (const inst of j.instruments) {
      if (inst.coverage?.type !== 'arcgis') continue;
      tasks.push(
        queryGeoJSONInBBox(inst.coverage.url, bbox, { where: inst.coverage.where || '1=1', outFields: ['OBJECTID'], maxFeatures: 3000 })
          .then((r) => r.features.map((f) => ({ ...f, properties: { jurisdiction: name, title: inst.title } }))),
      );
    }
  }
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

export function exclusionLayer(L, features) {
  return L.geoJSON(features, {
    interactive: false,
    style: { color: css('--excl') || '#d97706', weight: 1.6, dashArray: '2 4', fillOpacity: 0 },
  });
}

export function parcelsToCSV(parcels) {
  const head = ['county', 'apn', 'address', 'best_zone', 'tier', 'band', 'all_zones'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = parcels.map((p) => {
    const z = p.properties._zones || [];
    return [p.properties.countyId, p.properties.apn, p.properties.address, p.properties._code, z[0]?.tier ?? '', z[0]?.band ?? '', z.map(zoneCode).join(' ')].map(q).join(',');
  });
  return [head.join(','), ...lines].join('\n');
}
