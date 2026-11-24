// Street right-of-way width from assessor parcel geometry.
//
// AB 2011 (Gov. Code § 65912.101(c)) defines a commercial corridor by its
// right-of-way width (70–150 ft). The right-of-way is the public land between
// the private parcels on either side of the street, so its width is measured
// property line to property line: from the subject parcel's frontage straight
// across to the first parcel on the other side. HCD's draft AB 2011 guidelines
// (§ 102 / § 300(a)(5)(A)(i), May 5, 2026): where the width varies, the site is
// eligible if any portion of the right-of-way fronting it is 70–150 ft.
//
// Pure geometry; works in a local planar projection (feet) around the parcel.

const FT_PER_M = 3.28084;

/** Local equirectangular projection to feet, accurate to well under 0.1% over a few hundred feet. */
export function projector([lon0, lat0]) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180) * FT_PER_M;
  const ky = 110574 * FT_PER_M;
  return {
    fwd: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: ([x, y]) => [x / kx + lon0, y / ky + lat0],
  };
}

function rings(geom) {
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

function pointInRings(pt, rs) {
  // Even-odd rule across all rings (outer + holes).
  let inside = false;
  for (const r of rs) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance along ray (o + t·d, t > 0) to segment a–b, or Infinity. */
function rayHit(o, d, a, b) {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const wx = a[0] - o[0];
  const wy = a[1] - o[1];
  const t = (wx * ey - wy * ex) / den;
  const u = (wx * d[1] - wy * d[0]) / den;
  return t > 1e-6 && u >= 0 && u <= 1 ? t : Infinity;
}

/**
 * Measure the right-of-way along each street frontage of `parcel`.
 * @param parcel     GeoJSON Feature (Polygon/MultiPolygon, WGS84)
 * @param neighbors  GeoJSON Features of all parcels within ~250 ft (the subject may be included)
 * @param opts.step  sample spacing along frontage, ft
 * @param opts.cornerTrim  ignore samples this close to a frontage's ends, ft (rays there cross intersections)
 * @param opts.maxFt longest ray, ft (beyond this the far side is treated as unparcelled)
 * @returns frontages: [{ lengthFt, bearingDeg, samples: [{ widthFt|null, at:[lon,lat] }], widthFt: {min, median, max}|null }]
 */
export function measureFrontages(parcel, neighbors, { step = 10, cornerTrim = 15, maxFt = 250, probeFt = 3, minFt = 5 } = {}) {
  const pr = rings(parcel.geometry);
  if (!pr.length) return [];
  const origin = pr[0][0];
  const P = projector(origin);
  const subj = pr.map((r) => r.map(P.fwd));
  const others = neighbors
    .filter((n) => n !== parcel && n.geometry && JSON.stringify(n.geometry.coordinates[0]?.[0]) !== JSON.stringify(parcel.geometry.coordinates[0]?.[0]))
    .map((n) => rings(n.geometry).map((r) => r.map(P.fwd)));
  const segs = others.flatMap((rs) => rs.flatMap((r) => r.slice(1).map((p, i) => [r[i], p])));

  // Orientation of the outer ring decides which side is "outward".
  const outer = subj[0];
  let area2 = 0;
  for (let i = 0; i < outer.length - 1; i++) area2 += outer[i][0] * outer[i + 1][1] - outer[i + 1][0] * outer[i][1];
  const ccw = area2 > 0;

  const frontEdges = [];
  for (let i = 0; i < outer.length - 1; i++) {
    const a = outer[i];
    const b = outer[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1) continue;
    const t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n = ccw ? [t[1], -t[0]] : [-t[1], t[0]]; // outward normal
    // A frontage edge has no parcel immediately outside it.
    const mid = [(a[0] + b[0]) / 2 + n[0] * probeFt, (a[1] + b[1]) / 2 + n[1] * probeFt];
    const outsideIsParcel = others.some((rs) => pointInRings(mid, rs));
    frontEdges.push({ a, b, len, t, n, street: !outsideIsParcel });
  }

  // Merge consecutive street-facing edges with similar bearing into frontages (one per street side).
  const groups = [];
  for (const e of frontEdges) {
    if (!e.street) {
      groups.push(null);
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.n[0] * e.n[0] + last.n[1] * e.n[1]) > Math.cos((25 * Math.PI) / 180)) {
      last.edges.push(e);
    } else {
      groups.push({ n: e.n, edges: [e] });
    }
  }
  // Wrap-around: last group continues into the first.
  const real = groups.filter(Boolean);
  if (groups.length > 1 && groups[0] && groups[groups.length - 1] && real.length > 1) {
    const first = groups[0];
    const last = groups[groups.length - 1];
    if (Math.abs(last.n[0] * first.n[0] + last.n[1] * first.n[1]) > Math.cos((25 * Math.PI) / 180)) {
      first.edges = [...last.edges, ...first.edges];
      real.pop();
    }
  }

  return real.map((g) => {
    const lengthFt = g.edges.reduce((s, e) => s + e.len, 0);
    const samples = [];
    let along = 0;
    for (const e of g.edges) {
      for (let s = step / 2; s < e.len; s += step) {
        const pos = along + s;
        if (pos < cornerTrim || pos > lengthFt - cornerTrim) continue;
        const o = [e.a[0] + e.t[0] * s, e.a[1] + e.t[1] * s];
        let best = Infinity;
        for (const [p, q] of segs) {
          const d = rayHit(o, e.n, p, q);
          if (d >= minFt && d < best) best = d; // < minFt: grazing a neighbour that touches the corner
        }
        samples.push({ widthFt: best <= maxFt ? Math.round(best * 10) / 10 : null, at: P.inv(o) });
      }
      along += e.len;
    }
    const w = samples.map((x) => x.widthFt).filter((x) => x != null).sort((x, y) => x - y);
    const bearingDeg = Math.round(((Math.atan2(g.n[0], g.n[1]) * 180) / Math.PI + 360) % 360);
    return {
      lengthFt: Math.round(lengthFt),
      facing: bearingDeg, // compass direction the frontage faces
      samples,
      widthFt: w.length ? { min: w[0], median: w[Math.floor(w.length / 2)], max: w[w.length - 1], measured: w.length, unmeasured: samples.length - w.length } : null,
    };
  });
}

/**
 * AB 2011 commercial-corridor test for one frontage (§ 65912.101(c); § 65912.121(a)(1)):
 * right-of-way 70–150 ft along at least part of it (HCD draft guidelines: "any portion"),
 * and at least 50 ft of frontage. Requires two adjacent samples in range so a single
 * stray ray at a driveway or intersection cannot qualify a frontage by itself.
 */
export function corridorTest(frontage, { min = 70, max = 150, minFrontageFt = 50 } = {}) {
  const inRange = frontage.samples.map((s) => s.widthFt != null && s.widthFt >= min && s.widthFt <= max);
  let run = 0;
  let longest = 0;
  for (const ok of inRange) {
    run = ok ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return {
    rowInRange: longest >= 2,
    frontageOk: frontage.lengthFt >= minFrontageFt,
    qualifies: longest >= 2 && frontage.lengthFt >= minFrontageFt,
    wide: frontage.widthFt ? frontage.widthFt.median >= 100 : null, // § 65912.123: < 100 ft vs ≥ 100 ft standards
  };
}
