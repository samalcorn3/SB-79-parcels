// Local zoning for a parcel, and what it means for AB 2011's first site test:
// "located in a zone where office, retail, or parking are a principally
// permitted use" (Gov. Code §§ 65912.111(a), 65912.121(a); definition in
// § 65912.101(u)).
//
// data/zoning/<id>.json holds, per jurisdiction, the live zoning layer and rules
// mapping zone codes (or the city's own zone categories) to a class of zone
// with a status. data/zoning.json holds the shared classes and rules and an
// index of which file serves which city; a jurisdiction's file is fetched only
// when a parcel there is looked up, so the site never loads zoning it doesn't
// need. Only the jurisdiction's own current layer is used: the city's, or the
// county's for unincorporated land. No regional compilations.
import * as turf from '@turf/turf';
import { queryIntersecting, toEsriGeometry, getJSON } from './arcgis.js';
import { getField } from './spec.js';

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** The index entry for a parcel's zoning: the city's own, or the county's for unincorporated land. */
export function pickZoningSource(zoning, { countyId, cityName }) {
  const s = zoning.index;
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
export function classifyZone(zoning, source, { code, category, description }) {
  const value = { code: String(code ?? '').trim(), category: String(category ?? '').trim(), description: String(description ?? '').trim() };
  const g = source.generic ? zoning.genericRules : null;
  // Shared rules read the jurisdiction's own zone description (or category), then common code prefixes.
  const shared = g ? [
    ...g.description.map((r) => ({ ...r, on: value.description ? 'description' : 'category', flags: 'i', cite: `${source.codeName || `${source.name} zoning ordinance`} (zone described by the jurisdiction as “{text}”)` })),
    ...g.code.map((r) => ({ ...r, cite: `${source.codeName || `${source.name} zoning ordinance`} (zone ${value.code})` })),
  ] : [];
  const rule = [...(source.rules || []), ...shared].find((r) => value[r.on || 'code'] && new RegExp(r.match, r.flags || '').test(value[r.on || 'code']));
  const cls = zoning.classes[rule?.class || 'unknown'];
  let status = rule?.status || cls.status;
  const notes = [];
  for (const f of source.flags || []) {
    if (!new RegExp(f.match).test(value.code)) continue;
    notes.push(f.note);
    if (f.status === 'confirm' && status === 'meets') status = 'confirm';
  }
  const cite = rule?.cite ? rule.cite.replace('{text}', value[rule.on || 'code']) : null;
  return { class: rule?.class || 'unknown', label: cls.label, status, why: rule?.why || cls.why, cite, notes };
}

/** Overall status for a site that may span several zones. */
export function combineZoneStatuses(statuses) {
  if (!statuses.length) return 'not-evaluated';
  if (statuses.every((s) => s === 'meets')) return 'meets';
  if (statuses.every((s) => s === 'fails')) return 'fails';
  return 'confirm';
}

const sourceCache = new WeakMap();
/**
 * One jurisdiction's layer and rules (data/zoning/<id>.json), fetched once.
 * The data loader supplies `zoning.loadSource(id)` (fetch in the browser, a file read in Node).
 */
export function loadZoningSource(zoning, id) {
  if (!sourceCache.has(zoning)) sourceCache.set(zoning, new Map());
  const cache = sourceCache.get(zoning);
  if (!cache.has(id)) {
    if (typeof zoning.loadSource !== 'function') return Promise.reject(new Error('No zoning source loader configured.'));
    cache.set(id, Promise.resolve(zoning.loadSource(id)).catch((e) => {
      cache.delete(id);
      throw e;
    }));
  }
  return cache.get(id);
}

const updatedCache = new Map();
/**
 * When the agency last changed its zoning layer, and how that is known:
 * the layer's edit record, the latest value of a per-feature date field (`updatedField`),
 * or, for layers that report neither, a date recorded in the source file (`asOf`).
 * @returns {Promise<{date: string, basis: string} | null>}
 */
export function layerUpdatedInfo(source) {
  const fallback = source.asOf?.date ? { date: source.asOf.date, basis: source.asOf.basis || 'date recorded when this layer was added' } : null;
  if (!source.url || source.asOf?.override) return Promise.resolve(fallback);
  if (!updatedCache.has(source.url)) {
    updatedCache.set(source.url, (async () => {
      const info = await getJSON(source.url, { f: 'json' }, { retries: 1, timeoutMs: 10000 });
      const e = info.editingInfo || {};
      let t = e.dataLastEditDate || e.lastEditDate || null;
      let basis = t ? 'the layer’s edit record' : null;
      if (source.updatedField) {
        const st = await getJSON(`${source.url}/query`, {
          where: '1=1', f: 'json',
          outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: source.updatedField, outStatisticFieldName: 'm' }]),
        }, { retries: 1, timeoutMs: 10000 }).catch(() => null);
        const m = st?.features?.[0]?.attributes?.m;
        if (typeof m === 'number' && (!t || m > t)) {
          t = m;
          basis = `the latest date in the layer’s ${source.updatedField} field`;
        }
      }
      return t ? { date: new Date(t).toISOString().slice(0, 10), basis } : fallback;
    })().catch(() => fallback));
  }
  return updatedCache.get(source.url);
}

/** The layer's last-update date only (YYYY-MM-DD), or null. */
export async function layerUpdated(source) {
  return (await layerUpdatedInfo(source))?.date || null;
}

/** Layers last updated before this date may predate the 2023–24 housing-element rezonings. */
export const CURRENT_SINCE = '2023-01-01';

/** Shrink the parcel slightly so slivers along a shared boundary don't count as a second zone. */
function innerGeometry(parcel) {
  try {
    const inner = turf.buffer(parcel, -1.5, { units: 'meters' });
    if (inner && turf.area(inner) > 0.25 * turf.area(parcel)) return inner.geometry;
  } catch { /* fall through */ }
  return parcel.geometry;
}

const blank = (v) => v == null || /^\s*(-|0|none|null|n\/a)?\s*$/i.test(String(v));
/** A URL from a plain value or from an HTML anchor (some layers store `<a href=…>`). */
export function urlFrom(v) {
  const m = String(v ?? '').match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

/**
 * Development limits stated in a zone's own name or description in the city's layer,
 * e.g. "Residential 20 du/ac" or "Single-Family (7,500 sq. ft. minimum lot size)".
 */
export function limitsFromText(text) {
  const t = String(text ?? '');
  const out = [];
  const du = '(?:du\\s*/\\s*ac(?:re)?|d\\.u\\.\\s*/\\s*ac|dwelling units?\\s*(?:per|/)\\s*acre|units?\\s*(?:per|/)\\s*(?:net\\s+)?acre|units/ac)';
  const range = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:-|–|to)\\s*(\\d+(?:\\.\\d+)?)\\s*${du}`, 'i'));
  const single = !range && t.match(new RegExp(`(?:up to\\s*)?(\\d+(?:\\.\\d+)?)\\s*${du}`, 'i'));
  if (range) out.push({ label: 'Density', value: `${range[1]}–${range[2]} units per acre` });
  else if (single) out.push({ label: 'Density', value: `${/up to/i.test(single[0]) ? 'up to ' : ''}${single[1]} units per acre` });
  const lot = t.match(/(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:sq\.?\s*ft\.?|s\.?\s*f\.?|square[- ]f(?:oo|ee)t)/i);
  if (lot) {
    const perUnit = /per\s*(?:unit|d\.?u\.?|dwelling)|\/\s*d\.?u\.?/i.test(t);
    out.push({ label: perUnit ? 'Lot area per unit' : 'Minimum lot size', value: `${lot[1]} sq ft` });
  }
  return out;
}

/**
 * Zoning of a parcel with its AB 2011 classification, what the layer says the zone allows,
 * when the layer was last updated, and where it came from.
 * @returns {{ source, zones: [{code, description, category, class, label, status, why, cite, notes, limits, link}], status } | { status: 'not-evaluated', reason }}
 */
export async function zoningForParcel(data, { countyId, cityName, parcel }) {
  const zoning = data.zoning;
  if (!zoning) return { status: 'not-evaluated', reason: 'Zoning rules not loaded.' };
  const entry = pickZoningSource(zoning, { countyId, cityName });
  if (!entry) return { status: 'not-evaluated', reason: `${cityName || 'This county'} does not publish a zoning layer this site can read (see docs/HANDOFF.md), so this test is not evaluated. Regional compilations are not used: they lag the city’s current zoning.` };
  const source = await loadZoningSource(zoning, entry.id);

  let raw;
  if (source.fromParcel) {
    const codes = String(parcel.properties.zoning || '').split('|').map((x) => x.trim()).filter(Boolean);
    raw = codes.map((code) => ({ code, description: codes.length === 1 ? parcel.properties.zoningDescription : null }));
  } else {
    const f = source.fields;
    const std = source.standards || [];
    const opts = { outFields: [...new Set([...Object.values(f), ...std.map((x) => x.field)])], request: { timeoutMs: 15000, retries: 1 } };
    // Query with the parcel's shape; some county servers refuse long geometry queries, so fall back to an interior point.
    const rows = await queryIntersecting(source.url, toEsriGeometry(innerGeometry(parcel)), opts)
      .catch(() => queryIntersecting(source.url, toEsriGeometry(turf.pointOnFeature(parcel).geometry), opts));
    raw = rows.map((r) => {
      const z = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, getField(r, v)]));
      z.layerLimits = std.map((x) => ({ label: x.label, value: getField(r, x.field) })).filter((x) => !blank(x.value)).map((x) => ({ ...x, value: String(x.value).trim() }));
      return z;
    });
  }
  const seen = new Set();
  const zones = [];
  for (const z of raw) {
    const key = `${z.code}|${z.category ?? ''}`;
    if (!z.code && !z.category) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = classifyZone(zoning, source, z);
    // A layer known to be unreliable never decides the test outright.
    if (source.statusCap === 'confirm' && c.status !== 'confirm') {
      c.status = 'confirm';
      c.notes = [...c.notes, source.caveat || 'This layer has known gaps, so the result is not decided from it.'];
    }
    const { layerLimits = [], link: linkValue, ...rest } = z;
    const named = limitsFromText(`${z.description || ''} ${z.category || ''}`).filter((x) => !layerLimits.some((y) => y.label === x.label));
    zones.push({
      ...rest,
      ...c,
      limits: [...layerLimits.map((x) => ({ ...x, from: 'layer' })), ...named.map((x) => ({ ...x, from: 'name' }))],
      link: urlFrom(linkValue),
    });
  }
  const updated = await layerUpdatedInfo(source);
  const info = { ...sourceInfo(source), updated: updated?.date || null, updatedBasis: updated?.basis || null, stale: Boolean(updated?.date && updated.date < CURRENT_SINCE) };
  if (!zones.length) return { status: 'not-evaluated', reason: `${source.publisher} shows no zone on this parcel.`, source: info };
  return { source: info, zones, status: combineZoneStatuses(zones.map((z) => z.status)) };
}

/** How the layer was obtained: who publishes and hosts it, and how the site reads it. */
export function provenance(s) {
  if (s.fromParcel) return { kind: 'parcel', text: `Read from the zoning recorded on the parcel in ${s.publisher}.` };
  let host = '';
  try { host = new URL(s.url).host; } catch { /* no url */ }
  if (s.thirdParty) {
    return {
      kind: 'third-party',
      text: `Hosted by ${s.thirdParty.name}, not by ${s.name}. ${s.thirdParty.note || ''} Used only because ${s.name} does not publish a zoning layer of its own; confirm the zoning with the city.`.replace(/\s+/g, ' ').trim(),
    };
  }
  const where = /(^|\.)arcgis\.com$/.test(host)
    ? (host.startsWith('utility.') ? 'through an ArcGIS Online proxy to its own GIS server' : 'on its own ArcGIS Online organisation')
    : `on its own GIS server (${host})`;
  const agency = s.unincorporatedOf ? s.name.replace(/^Unincorporated /, 'the County of ').replace(/ County$/, '') : s.name;
  return { kind: 'own', text: `Published by ${agency} ${where}.` };
}

function sourceInfo(s) {
  return {
    id: s.id, name: s.name, publisher: s.publisher, url: s.url || null, codeUrl: s.codeUrl || null, codeName: s.codeName || null,
    provenance: provenance(s), caveat: s.caveat || null, note: s.note || null,
  };
}

/** One line describing the zoning, for report headers. */
export function zoningSummary(z) {
  if (!z?.zones?.length) return null;
  return z.zones.map((x) => `${x.code}${x.description && x.description !== x.code ? ` (${x.description})` : ''}`).join(' / ');
}
