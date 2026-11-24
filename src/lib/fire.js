// Fire hazard severity zones from CAL FIRE's Office of the State Fire Marshal.
//
// SB 79 does not remove fire zones from TOD zones by itself. The statute uses
// them in three places:
//   § 65912.161(b)(1)(D) a city MAY adopt an ordinance temporarily excluding
//                        "sites within a very high fire hazard severity zone …
//                        or within the state responsibility area";
//   § 65912.161(a)(2)(A) a TOD alternative plan may cut density on such sites
//                        by more than 50%;
//   § 65912.159(a)(3)    the streamlined ministerial path (§ 65913.4) is not
//                        available on a site in a very high FHSZ.
import * as turf from '@turf/turf';
import { queryIntersecting, toEsriGeometry } from './arcgis.js';

const MIN_OVERLAP_SQM = 1; // ignore slivers from boundaries that coincide with lot lines

/** Share (0–1) of a parcel's area that falls inside any of the given polygons. */
export function overlapShare(parcel, polygons) {
  const area = turf.area(parcel);
  if (!area || !polygons.length) return 0;
  const pb = turf.bbox(parcel);
  const verts = turf.coordAll(parcel);
  let covered = 0;
  for (const f of polygons) {
    const fb = f.bbox || turf.bbox(f);
    if (fb[0] > pb[2] || fb[2] < pb[0] || fb[1] > pb[3] || fb[3] < pb[1]) continue;
    try {
      // Fast paths: most parcels sit wholly inside or wholly outside a fire zone.
      const inside = verts.filter((v) => turf.booleanPointInPolygon(v, f, { ignoreBoundary: false })).length;
      if (inside === verts.length && !turf.booleanIntersects(turf.polygonToLine(f), turf.polygonToLine(parcel.geometry ? parcel : turf.feature(parcel)))) {
        return 1;
      }
      if (inside === 0 && !turf.booleanIntersects(parcel, f)) continue;
      const inter = turf.intersect(turf.featureCollection([turf.feature(parcel.geometry || parcel), f]));
      if (inter) covered += turf.area(inter);
    } catch {
      /* invalid source geometry; skip */
    }
  }
  const share = Math.min(1, covered / area);
  return covered >= MIN_OVERLAP_SQM ? share : 0;
}

/** Summarise fire-zone polygons (already fetched) against one parcel. */
export function fireStatus(parcel, { vhfhsz = [], sra = [] }) {
  const v = overlapShare(parcel, vhfhsz);
  const s = overlapShare(parcel, sra);
  // The statute says "sites within" a zone (§ 65912.161(b)(1)(D); § 65913.4(a)(6)(D))
  // and does not say how to treat a site only partly inside one. We therefore
  // distinguish: `within` = the whole parcel is inside (≥ 99.5% by area, to absorb
  // boundary-digitising noise); `partial` = some but not all of it is.
  const WHOLE = 0.995;
  const within = v >= WHOLE || s >= WHOLE || v + s >= WHOLE; // "VHFHSZ or SRA" (§ 65912.161(b)(1)(D))
  return {
    vhfhsz: { hit: v > 0, share: v, within: v >= WHOLE },
    sra: { hit: s > 0, share: s, within: s >= WHOLE },
    within,
    partial: !within && (v > 0 || s > 0),
    qualifies: within,
  };
}

/**
 * Does a parcel meet a local ordinance's fire criterion?
 *   'vhfhsz-or-sra' — the full § 65912.161(b)(1)(D) criterion
 *   'vhfhsz'        — ordinances that exclude only very high FHSZ sites (e.g. San Diego O-22099 § 4)
 * Returns 'within' | 'partial' | 'outside'.
 */
export function fireCriterionStatus(fire, criterion) {
  if (!fire) return 'unknown';
  if (criterion === 'vhfhsz') return fire.vhfhsz.within ? 'within' : fire.vhfhsz.hit ? 'partial' : 'outside';
  return fire.within ? 'within' : fire.partial ? 'partial' : 'outside';
}

/** Live query of both OSFM layers for one parcel. */
export async function fireForParcel(sources, parcel) {
  const cfg = sources.fireHazard;
  const geo = toEsriGeometry(parcel.geometry);
  const [vhfhsz, sra] = await Promise.all(
    [cfg.vhfhsz, cfg.sra].map((l) => queryIntersecting(l.url, geo, { where: l.where, outFields: ['OBJECTID'], returnGeometry: true, extra: { maxAllowableOffset: 0.000005 } })),
  );
  return { ...fireStatus(parcel, { vhfhsz, sra }), publisher: cfg.publisher };
}
