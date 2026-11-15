// SB 79 development standards, computed from data/standards.json, which
// transcribes Gov. Code § 65912.157 (see data/statute/65912.157.txt).

const KEYS = ['heightFt', 'densityDuAc', 'far'];

/**
 * Standards for one tier/band. ¼- and ½-mile figures come straight from
 * § 65912.157(a)(3)–(6). "Adjacent" is the ¼-mile figure for the tier plus
 * the § 65912.157(e) adjacency intensifier.
 */
export function standardsFor(doc, tier, band) {
  const t = doc.tiers[String(tier)];
  if (!t) return null;
  if (band === 'adjacent') {
    const ai = doc.adjacencyIntensifier;
    const base = t[ai.base];
    if (!base) return null;
    const out = { tier, band, cite: `${base.cite} + ${ai.cite}`, concessionDensityDuAc: base.concessionDensityDuAc, intensifier: true };
    for (const k of KEYS) out[k] = Math.round((base[k] + ai[k]) * 10) / 10;
    return out;
  }
  const s = t[band];
  return s ? { tier, band, ...s, intensifier: false } : null;
}

/**
 * For a parcel in one or more zones, each figure is the most permissive among
 * the applicable zones; we report every zone's row and which zone each
 * maximum came from (with its statutory citation).
 */
export function computeStandards(doc, zones) {
  const rows = zones.map((z) => ({ zone: z, ...standardsFor(doc, z.tier, z.band) })).filter((r) => r.heightFt != null);
  if (!rows.length) return null;
  const pick = (key) => rows.reduce((best, r) => (r[key] > best[key] ? r : best), rows[0]);
  const max = {};
  for (const k of KEYS) {
    const r = pick(k);
    max[k] = { value: r[k], from: r.zone, cite: r.cite };
  }
  // Lowest concession threshold among applicable zones is the easiest to reach.
  const conc = rows.reduce((best, r) => (r.concessionDensityDuAc < best.concessionDensityDuAc ? r : best), rows[0]);
  return {
    rows,
    max,
    concessionDensity: { value: conc.concessionDensityDuAc, from: conc.zone, cite: conc.cite },
  };
}

const SQFT_PER_ACRE = 43560;

/** Units allowed by the SB 79 density floor on a lot of the given area. */
export function unitsForLot(densityDuAc, lotSqFt) {
  if (!lotSqFt || !densityDuAc) return null;
  return Math.floor((densityDuAc * lotSqFt) / SQFT_PER_ACRE);
}

/** Fewest units a qualifying project must have: ≥ 5 units and ≥ 30 du/ac (§ 65912.157(a)(1)). */
export function minUnitsForLot(doc, lotSqFt) {
  if (!lotSqFt) return null;
  const byDensity = Math.ceil((doc.general.minDensityDuAc.value * lotSqFt) / SQFT_PER_ACRE);
  return Math.max(doc.general.minUnits.value, byDensity);
}

/** Residential floor area (net habitable sq ft, § 65912.156(l)) allowed by the FAR floor. */
export function floorAreaForLot(far, lotSqFt) {
  if (!lotSqFt || !far) return null;
  return Math.round(far * lotSqFt);
}

/** Project-level obligations that turn on the computed figures. */
export function projectRequirements(doc, std, lotSqFt) {
  if (!std) return null;
  const maxUnits = unitsForLot(std.max.densityDuAc.value, lotSqFt);
  return {
    minUnits: minUnitsForLot(doc, lotSqFt),
    maxUnits,
    floorAreaSqFt: floorAreaForLot(std.max.far.value, lotSqFt),
    concessionUnits: unitsForLot(std.concessionDensity.value, lotSqFt),
    affordabilityApplies: maxUnits == null ? null : maxUnits > doc.affordability.appliesAboveUnits,
    laborStandardsPossible: std.max.heightFt.value > doc.labor.heightFtOver,
  };
}
