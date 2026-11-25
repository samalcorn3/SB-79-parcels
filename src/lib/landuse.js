// Current use of a parcel and its neighbours, from the county assessor's
// parcel records, for AB 2011's site tests:
//   § 65912.111(c) / § 65912.121(e)  at least 75% of the site perimeter adjoins
//       parcels developed with urban uses; parcels separated only by a street,
//       pedestrian path, or bicycle path count as adjoining.
//   § 65912.111(d) / § 65912.121(f)  not on or adjoining (including across a
//       street) a site where more than one-third of the square footage is
//       dedicated to industrial use.
//   § 65912.121(h)(4)–(6)  not a property with one to four dwelling units; not
//       vacant land zoned for housing but not multifamily; not a mobilehome park.
//
// Uses are classified by the rules in sources.json → counties[].parcels.landUse.
import { projector, rings, pointInRings, rayHit } from './row.js';
import { getField } from './spec.js';

/** "Urban uses" (§ 65912.101(x)): residential, commercial, public institutional, park surrounded by urban uses, parking, transit, retail. */
export const URBAN = new Set(['residential', 'residential-small', 'mobilehome-park', 'commercial', 'parking', 'public', 'park', 'transit']);
/** Not urban uses, and decisive: they count against the 75% test. */
export const NON_URBAN = new Set(['industrial', 'utility', 'agricultural']);
export const CLASS_LABEL = {
  residential: 'residential (5+ units)', 'residential-small': 'residential (1–4 units)', 'mobilehome-park': 'mobilehome park', commercial: 'commercial',
  parking: 'parking', public: 'public or institutional', park: 'park', transit: 'transit', industrial: 'industrial', utility: 'utility',
  agricultural: 'agricultural', vacant: 'vacant', other: 'other', unknown: 'unclassified',
};

/** Classify one parcel's assessor record. Returns null when the county publishes no usable land-use field. */
export function landUseOf(cfg, raw) {
  if (!cfg || !raw) return null;
  const v = Object.fromEntries(Object.entries(cfg.fields).map(([k, f]) => [k, Array.isArray(f) ? f.map((x) => getField(raw, x)) : getField(raw, f)]));
  const units = Array.isArray(v.units) ? v.units.reduce((s, x) => s + (Number(x) || 0), 0) : null;
  const text = [v.description, v.general, v.specific].filter((x) => x != null && String(x).trim() && String(x) !== 'None').join(' / ');
  let cls;
  if (cfg.vacantWhenNoImprovements && v.improvementValue != null && Number(v.improvementValue) === 0) cls = 'vacant';
  else {
    const rule = cfg.rules.find((r) => v[r.on] != null && new RegExp(r.match).test(String(v[r.on]).trim()));
    cls = rule ? rule.class : 'unknown';
  }
  // The unit count, where published, settles 1–4 units vs. 5 or more.
  if (units != null && units > 0 && (cls === 'residential' || cls === 'residential-small')) cls = units <= 4 ? 'residential-small' : 'residential';
  return { class: cls, label: CLASS_LABEL[cls], description: text || null, units };
}

/**
 * Walk the subject's perimeter and find, for each stretch, the parcel it adjoins:
 * the parcel immediately outside it, or the first parcel straight across the street.
 * @returns [{ neighbor (Feature), lengthFt, acrossStreet }] plus `unmatchedFt` for stretches facing nothing within reach.
 */
export function adjoiningParcels(parcel, neighbors, { step = 5, probeFt = 3, maxFt = 250 } = {}) {
  const pr = rings(parcel.geometry);
  if (!pr.length) return { adjoining: [], unmatchedFt: 0, perimeterFt: 0 };
  const P = projector(pr[0][0]);
  const subj = pr.map((r) => r.map(P.fwd));
  const xs = subj.flat().map((p) => p[0]);
  const ys = subj.flat().map((p) => p[1]);
  const reach = [Math.min(...xs) - maxFt, Math.min(...ys) - maxFt, Math.max(...xs) + maxFt, Math.max(...ys) + maxFt];
  const subjKey = JSON.stringify(parcel.geometry.coordinates[0]?.[0]);
  const others = [];
  for (const n of neighbors) {
    if (n === parcel || !n.geometry || JSON.stringify(n.geometry.coordinates[0]?.[0]) === subjKey) continue;
    const rs = rings(n.geometry).map((r) => r.map(P.fwd));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rs) for (const [x, y] of r) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    if (x1 < reach[0] || x0 > reach[2] || y1 < reach[1] || y0 > reach[3]) continue;
    others.push({ feature: n, rs, bbox: [x0, y0, x1, y1] });
  }
  const segs = others.flatMap((o, i) => o.rs.flatMap((r) => r.slice(1).map((p, k) => [r[k], p, i])));

  const outer = subj[0];
  let area2 = 0;
  for (let i = 0; i < outer.length - 1; i++) area2 += outer[i][0] * outer[i + 1][1] - outer[i + 1][0] * outer[i][1];
  const ccw = area2 > 0;

  const byNeighbor = new Map();
  let unmatchedFt = 0;
  let perimeterFt = 0;
  for (let i = 0; i < outer.length - 1; i++) {
    const a = outer[i];
    const b = outer[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    perimeterFt += len;
    const t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n = ccw ? [t[1], -t[0]] : [-t[1], t[0]];
    const count = Math.max(1, Math.round(len / step));
    for (let k = 0; k < count; k++) {
      const s = ((k + 0.5) / count) * len;
      const o = [a[0] + t[0] * s, a[1] + t[1] * s];
      const probe = [o[0] + n[0] * probeFt, o[1] + n[1] * probeFt];
      let hit = others.findIndex((x) => probe[0] >= x.bbox[0] && probe[0] <= x.bbox[2] && probe[1] >= x.bbox[1] && probe[1] <= x.bbox[3] && pointInRings(probe, x.rs));
      let across = false;
      if (hit < 0) {
        let best = maxFt;
        for (const [p, q, idx] of segs) {
          const d = rayHit(o, n, p, q);
          if (d > 1 && d < best) { best = d; hit = idx; }
        }
        across = hit >= 0;
      }
      const piece = len / count;
      if (hit < 0) { unmatchedFt += piece; continue; }
      const e = byNeighbor.get(hit) || { neighbor: others[hit].feature, lengthFt: 0, acrossStreet: across };
      e.lengthFt += piece;
      e.acrossStreet = e.acrossStreet && across;
      byNeighbor.set(hit, e);
    }
  }
  return { adjoining: [...byNeighbor.values()], unmatchedFt, perimeterFt };
}

/**
 * AB 2011 use tests for a parcel.
 * @param cfg        the county's parcels.landUse config (or null)
 * @param parcel     subject Feature (properties.raw = assessor record)
 * @param neighbors  nearby parcel Features with land-use fields
 */
export function useTests(cfg, parcel, neighbors) {
  if (!cfg) return null;
  const site = landUseOf(cfg, parcel.properties.raw);
  const { adjoining, unmatchedFt, perimeterFt } = adjoiningParcels(parcel, neighbors);
  // Stacked parcels (condominiums) share one footprint: count each footprint once, by its first record.
  const lengths = { urban: 0, nonUrban: 0, undetermined: unmatchedFt };
  const byClass = {};
  const industrial = [];
  for (const a of adjoining) {
    const u = landUseOf(cfg, a.neighbor.properties.raw) || { class: 'unknown', label: CLASS_LABEL.unknown };
    a.use = u;
    byClass[u.class] = (byClass[u.class] || 0) + a.lengthFt;
    if (URBAN.has(u.class)) lengths.urban += a.lengthFt;
    else if (NON_URBAN.has(u.class)) lengths.nonUrban += a.lengthFt;
    else lengths.undetermined += a.lengthFt;
    if (u.class === 'industrial' || u.class === 'utility') industrial.push({ address: a.neighbor.properties.address, apn: a.neighbor.properties.apn, use: u, acrossStreet: a.acrossStreet });
  }
  const total = lengths.urban + lengths.nonUrban + lengths.undetermined || 1;
  return {
    publisher: cfg.publisher,
    site,
    perimeterFt: Math.round(perimeterFt),
    share: { urban: lengths.urban / total, nonUrban: lengths.nonUrban / total, undetermined: lengths.undetermined / total },
    byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v / total])),
    industrialNeighbors: industrial,
    adjoiningCount: adjoining.length,
  };
}
