// Statutory SB 79 standards for a set of zone hits.

/** Standards for one tier/band combination, or null. */
export function standardsFor(standardsDoc, tier, band) {
  const t = standardsDoc.tiers[String(tier)];
  return t && t[band] ? { tier, band, ...t[band] } : null;
}

/**
 * For a parcel in one or more zones, the applicant may rely on whichever
 * applicable zone yields the most permissive figure for each standard.
 * We return every zone's row plus the per-standard maximum, and say which
 * zone each maximum came from.
 */
export function computeStandards(standardsDoc, zones) {
  const rows = zones.map((z) => ({ zone: z, ...standardsFor(standardsDoc, z.tier, z.band) })).filter((r) => r.heightFt != null);
  if (!rows.length) return null;
  const pick = (key) => rows.reduce((best, r) => (r[key] > best[key] ? r : best), rows[0]);
  const h = pick('heightFt');
  const d = pick('densityDuAc');
  const f = pick('far');
  return {
    rows,
    max: {
      heightFt: { value: h.heightFt, from: h.zone },
      densityDuAc: { value: d.densityDuAc, from: d.zone },
      far: { value: f.far, from: f.zone },
    },
  };
}

/** Units allowed by the SB 79 density floor on a lot of the given area. */
export function unitsForLot(densityDuAc, lotSqFt) {
  if (!lotSqFt || !densityDuAc) return null;
  return Math.floor((densityDuAc * lotSqFt) / 43560);
}

/** Residential floor area allowed by the FAR floor on a lot. */
export function floorAreaForLot(far, lotSqFt) {
  if (!lotSqFt || !far) return null;
  return Math.round(far * lotSqFt);
}
