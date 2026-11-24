// Local zoning for a parcel, and what it means for AB 2011's first site test:
// "located in a zone where office, retail, or parking are a principally
// permitted use" (Gov. Code §§ 65912.111(a), 65912.121(a); definition in
// § 65912.101(u)).
//
// data/zoning.json lists, per jurisdiction, the live zoning layer and rules
// mapping zone codes (or the city's own zone categories) to a class of zone
// with a status. Only the jurisdiction's own current layer is used: the city's,
// or the county's for unincorporated land. No regional compilations.
import * as turf from '@turf/turf';
import { queryIntersecting, toEsriGeometry, getJSON } from './arcgis.js';
import { getField } from './spec.js';

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** The zoning source for a parcel: the city's own, or the county's for unincorporated land. */
export function pickZoningSource(zoning, { countyId, cityName }) {
  const s = zoning.sources;
  if (cityName) {
    const own = s.find((x) => (x.jurisdictions || []).some((j) => fold(j) === fold(cityName)));
    if (own) return own;
  } else {
    const county = s.find((x) => x.unincorporatedOf === countyId);
    if (county) return county;
  }
  return null;
}

/** Class, status and reasons for one zone under a source's rules. */
export function classifyZone(zoning, source, { code, category }) {
  const value = { code: String(code ?? '').trim(), category: String(category ?? '').trim() };
  const rule = (source.rules || []).find((r) => new RegExp(r.match).test(value[r.on || 'code']));
  const cls = zoning.classes[rule?.class || 'unknown'];
  let status = rule?.status || cls.status;
  const notes = [];
  for (const f of source.flags || []) {
    if (!new RegExp(f.match).test(value.code)) continue;
    notes.push(f.note);
    if (f.status === 'confirm' && status === 'meets') status = 'confirm';
  }
  return { class: rule?.class || 'unknown', label: cls.label, status, why: rule?.why || cls.why, cite: rule?.cite || null, notes };
}

/** Overall status for a site that may span several zones. */
export function combineZoneStatuses(statuses) {
  if (!statuses.length) return 'not-evaluated';
  if (statuses.every((s) => s === 'meets')) return 'meets';
  if (statuses.every((s) => s === 'fails')) return 'fails';
  return 'confirm';
}

const updatedCache = new Map();
/**
 * When the agency last changed its zoning layer: the layer's edit date, or the latest
 * value of a per-feature date field (`updatedField`) for services that don't track edits.
 */
export function layerUpdated(source) {
  if (!source.url) return Promise.resolve(null);
  if (!updatedCache.has(source.url)) {
    updatedCache.set(source.url, (async () => {
      const info = await getJSON(source.url, { f: 'json' }, { retries: 1, timeoutMs: 10000 });
      const e = info.editingInfo || {};
      let t = e.dataLastEditDate || e.lastEditDate || null;
      if (source.updatedField) {
        const st = await getJSON(`${source.url}/query`, {
          where: '1=1', f: 'json',
          outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: source.updatedField, outStatisticFieldName: 'm' }]),
        }, { retries: 1, timeoutMs: 10000 }).catch(() => null);
        const m = st?.features?.[0]?.attributes?.m;
        if (typeof m === 'number' && (!t || m > t)) t = m;
      }
      return t ? new Date(t).toISOString().slice(0, 10) : null;
    })().catch(() => null));
  }
  return updatedCache.get(source.url);
}

/** Shrink the parcel slightly so slivers along a shared boundary don't count as a second zone. */
function innerGeometry(parcel) {
  try {
    const inner = turf.buffer(parcel, -1.5, { units: 'meters' });
    if (inner && turf.area(inner) > 0.25 * turf.area(parcel)) return inner.geometry;
  } catch { /* fall through */ }
  return parcel.geometry;
}

/**
 * Zoning of a parcel with its AB 2011 classification.
 * @returns {{ source, zones: [{code, description, category, class, label, status, why, cite, notes}], status } | { status: 'not-evaluated', reason }}
 */
export async function zoningForParcel(data, { countyId, cityName, parcel }) {
  const zoning = data.zoning;
  if (!zoning) return { status: 'not-evaluated', reason: 'Zoning rules not loaded.' };
  const source = pickZoningSource(zoning, { countyId, cityName });
  if (!source) return { status: 'not-evaluated', reason: `${cityName || 'This county'}’s own zoning layer is not wired in yet, so this test is not evaluated. (Regional compilations are not used: they lag the city’s current zoning.)` };

  let raw;
  if (source.fromParcel) {
    const codes = String(parcel.properties.zoning || '').split('|').map((x) => x.trim()).filter(Boolean);
    raw = codes.map((code) => ({ code, description: codes.length === 1 ? parcel.properties.zoningDescription : null }));
  } else {
    const f = source.fields;
    const opts = { outFields: Object.values(f), request: { timeoutMs: 15000, retries: 1 } };
    // Query with the parcel's shape; some county servers refuse long geometry queries, so fall back to an interior point.
    const rows = await queryIntersecting(source.url, toEsriGeometry(innerGeometry(parcel)), opts)
      .catch(() => queryIntersecting(source.url, toEsriGeometry(turf.pointOnFeature(parcel).geometry), opts));
    raw = rows.map((r) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, getField(r, v)])));
  }
  const seen = new Set();
  const zones = [];
  for (const z of raw) {
    const key = `${z.code}|${z.category ?? ''}`;
    if (!z.code && !z.category) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    zones.push({ ...z, ...classifyZone(zoning, source, z) });
  }
  const info = { ...sourceInfo(source), updated: await layerUpdated(source) };
  if (!zones.length) return { status: 'not-evaluated', reason: `${source.publisher} shows no zone on this parcel.`, source: info };
  return { source: info, zones, status: combineZoneStatuses(zones.map((z) => z.status)) };
}

function sourceInfo(s) {
  return { id: s.id, name: s.name, publisher: s.publisher, url: s.url || null, codeUrl: s.codeUrl || null, codeName: s.codeName || null };
}

/** One line describing the zoning, for report headers. */
export function zoningSummary(z) {
  if (!z?.zones?.length) return null;
  return z.zones.map((x) => `${x.code}${x.description && x.description !== x.code ? ` (${x.description})` : ''}`).join(' / ');
}
