// Normalising MPO TOD-zone features and classifying parcels against them.
import { readSpec } from './spec.js';

export const BAND_RANK = { adjacent: 3, quarter: 2, half: 1 };

/**
 * Turn one MPO zone feature's attributes into { tier, band, label, flags }.
 * Returns null if the feature cannot be interpreted (so it is never silently
 * mis-classified).
 */
export function normalizeZone(layerCfg, attrs, mpoId) {
  const tier = Number(readSpec(layerCfg.tier, attrs));
  const band = readSpec(layerCfg.band, attrs);
  if (![1, 2].includes(tier) || !BAND_RANK[band]) return null;
  const flags = (layerCfg.flags || [])
    .filter((f) => String(attrs?.[f.field] ?? '').toLowerCase().includes(f.contains.toLowerCase()))
    .map((f) => f.flag);
  return {
    mpo: mpoId,
    tier,
    band,
    label: readSpec(layerCfg.label, attrs) || `Tier ${tier} – ${band}`,
    flags,
  };
}

/** Higher tier (1 beats 2), then closer band, wins. */
export function compareZones(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  return BAND_RANK[b.band] - BAND_RANK[a.band];
}

/**
 * Collapse a list of zone hits to unique tier/band combos, best first.
 * A parcel can sit in several overlapping zones (e.g. Tier 2 adjacent and
 * Tier 1 half-mile); every one is reported, and standards are computed for each.
 */
export function dedupeZones(zones) {
  const seen = new Map();
  for (const z of zones.filter(Boolean)) {
    const key = `${z.tier}|${z.band}|${(z.flags || []).join(',')}`;
    if (!seen.has(key)) seen.set(key, { ...z, flags: [...(z.flags || [])] });
  }
  return [...seen.values()].sort(compareZones);
}

/** Short code used for map styling, e.g. "T1-adjacent". */
export function zoneCode(zone) {
  return zone ? `T${zone.tier}-${zone.band}` : 'none';
}

/**
 * Drop the ¼–½ mile band where the city has fewer than 35,000 residents
 * (Gov. Code § 65912.157(a)). MPO maps usually already do this; this is a
 * second check that only fires when population is known.
 */
export function applyPopulationRule(zones, population, minPopulation = 35000) {
  if (population == null || Number.isNaN(Number(population)) || Number(population) >= minPopulation) {
    return { zones, removed: [] };
  }
  return {
    zones: zones.filter((z) => z.band !== 'half'),
    removed: zones.filter((z) => z.band === 'half'),
  };
}
