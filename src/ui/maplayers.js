// Live map layers: MPO zones & stops, county parcels classified by zone,
// and published local exclusion layers. Everything is fetched from the
// publishers' servers for the current view; nothing is pre-processed.
import * as turf from '@turf/turf';
import { queryAllGeoJSON, queryGeoJSONInBBox, queryIntersecting, envelope } from '../lib/arcgis.js';
import { normalizeZone, dedupeZones, zoneCode } from '../lib/zones.js';
import { readSpec } from '../lib/spec.js';
import { parcelsInBBox } from '../lib/parcels.js';
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
        for (const f of out) f.bbox = turf.bbox(f);
        return out;
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

/** Classify parcels against zone features clipped to the working bbox. */
export function classifyParcels(parcels, zoneFeatures, bbox) {
  const pad = 0.002;
  const work = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  const clipped = zoneFeatures
    .filter((z) => bboxesOverlap(z.bbox, work))
    .map((z) => {
      try {
        const c = turf.bboxClip(z, work);
        return { ...c, properties: z.properties, bbox: turf.bbox(c) };
      } catch {
        return null;
      }
    })
    .filter((z) => z && z.geometry && z.geometry.coordinates.length);
  for (const p of parcels) {
    const pb = turf.bbox(p);
    const hits = [];
    for (const z of clipped) {
      if (!bboxesOverlap(pb, z.bbox)) continue;
      try {
        if (turf.booleanIntersects(p, z)) hits.push(z.properties._z);
      } catch {
        /* malformed geometry from source; skip */
      }
    }
    const zones = dedupeZones(hits);
    p.properties._zones = zones;
    p.properties._code = zoneCode(zones[0]);
  }
  return parcels;
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
      return c
        ? { color: c, weight: 0.8, opacity: 0.9, fillColor: c, fillOpacity: 0.45 }
        : { color: '#888', weight: 0.5, opacity: 0.6, fillOpacity: 0.02 };
    },
    onEachFeature: (f, layer) => {
      const z = f.properties._zones?.[0];
      layer.bindTooltip(`${f.properties.apn || f.properties.id}${f.properties.address ? ` · ${f.properties.address}` : ''}<br>${z ? `Tier ${z.tier} · ${z.band}` : 'Not in a TOD zone'}`, { sticky: true });
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
  const results = await Promise.allSettled(counties.map((c) => parcelsInBBox(c, bbox, { maxFeatures: 5000 })));
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
