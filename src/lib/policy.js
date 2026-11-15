// Which rules govern a parcel: § 65912.157, a local ordinance, or an HCD-approved
// TOD alternative plan. Encodes HCD's "TOD Project Compliance" rules:
//   * A TODAP governs only if HCD approved it (Gov. Code § 65912.161(d)).
//   * An implementing/exemption/temporary-exclusion ordinance governs unless
//     HCD has found it out of compliance.
//   * Otherwise § 65912.157 governs.
// https://www.hcd.ca.gov/planning-and-research/sb79-tod

export const HCD_STATUS_LABEL = {
  compliant: 'HCD found compliant',
  noncompliant: 'HCD found NOT compliant',
  pending: 'Submitted, HCD review pending',
  'technical-assistance': 'HCD technical assistance only',
  'not-submitted': 'Not yet submitted to HCD',
  unknown: 'HCD finding not yet recorded',
};

export const KIND_LABEL = {
  todap: 'TOD Alternative Plan',
  'exclusion-ordinance': 'Exemption / temporary-exclusion ("delay") ordinance',
  'implementing-ordinance': 'Implementing ordinance',
};

const LOCAL_IN_FORCE = new Set(['enacted', 'adopted']);

export function findJurisdiction(registry, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const key = Object.keys(registry.jurisdictions).find((k) => k.toLowerCase() === n);
  return key ? { name: key, ...registry.jurisdictions[key] } : null;
}

/** Does this instrument legally govern projects (ignoring geography)? */
export function instrumentInForce(inst) {
  const local = inst.local?.status;
  const hcd = inst.hcd?.status || 'unknown';
  if (!LOCAL_IN_FORCE.has(local)) {
    return { inForce: false, why: `Local status is "${local || 'unknown'}" — not adopted.` };
  }
  if (inst.kind === 'todap') {
    return hcd === 'compliant'
      ? { inForce: true, why: 'TOD alternative plan approved by HCD.' }
      : { inForce: false, why: 'A TOD alternative plan governs only once HCD approves it (Gov. Code § 65912.161(d)).' };
  }
  return hcd === 'noncompliant'
    ? { inForce: false, why: 'HCD found this ordinance out of compliance; HCD’s position is that § 65912.157 then governs. Under § 65912.160(d)(5) the city may instead amend the ordinance or re-enact it with findings, after which HCD may notify the Attorney General (§ 65912.160(d)(6)).' }
    : { inForce: true, why: hcd === 'compliant' ? 'Ordinance found compliant by HCD.' : 'Ordinance governs unless and until HCD finds it out of compliance. If HCD issues no findings within 90 days of submittal (120 with an extension), the ordinance is deemed compliant for penalty purposes (§ 65912.160(d)(3)).' };
}

/**
 * @param {object} p
 * @param {Array}  p.zones          deduped zone hits for the parcel
 * @param {object} p.county         county config from sources.json
 * @param {object|null} p.jurisdiction  registry entry (or null)
 * @param {string|null} p.cityName  incorporated city name, null if unincorporated
 * @param {object} p.coverage       map instrumentId -> { covered: true|false|null, reason?: string }
 */
export function determineRegime({ zones, county, jurisdiction, cityName, coverage = {} }) {
  const instruments = (jurisdiction?.instruments || []).map((inst) => {
    const force = instrumentInForce(inst);
    let covered = null;
    let reason;
    if (inst.coverage?.type === 'jurisdiction-wide') covered = true;
    else if (coverage[inst.id]) ({ covered, reason } = coverage[inst.id]);
    return { ...inst, inForce: force.inForce, inForceWhy: force.why, covered, coverageReason: reason };
  });

  const base = { instruments, notes: [] };

  if (!zones.length) {
    return {
      ...base,
      regime: 'not-in-zone',
      headline: county?.sb79Status === 'pending' ? 'SB 79 not yet in effect in this county' : 'Not in an SB 79 TOD zone',
      detail: county?.sb79Status === 'pending' ? county.statusNote : 'The parcel does not intersect any TOD zone on the MPO’s SB 79 map. Local zoning applies.',
    };
  }
  if (county?.sb79Status === 'pending') {
    base.notes.push(county.statusNote);
  }
  if (!cityName) {
    return {
      ...base,
      regime: 'not-yet-applicable',
      headline: 'Unincorporated area — SB 79 not yet applicable',
      detail: 'SB 79 does not apply in unincorporated county areas until the county’s 7th-cycle housing element is due (Gov. Code § 65912.157(n); HCD advisory, Mar. 20, 2026). County zoning applies until then.',
    };
  }

  const todap = instruments.find((i) => i.kind === 'todap' && i.inForce && i.covered === true);
  const exclusion = instruments.find((i) => i.kind !== 'todap' && i.inForce && i.covered === true);
  const possibleExclusion = instruments.find((i) => i.kind !== 'todap' && i.inForce && i.covered == null);

  if (exclusion) {
    return {
      ...base,
      regime: 'excluded',
      governing: exclusion,
      headline: 'Excluded or exempted by local ordinance',
      detail: `${cityName}’s ${KIND_LABEL[exclusion.kind] || 'ordinance'} covers this parcel${exclusion.coverageReason ? ` (${exclusion.coverageReason})` : ''}. § 65912.157 standards do not currently apply; local zoning governs${exclusion.effectiveUntil ? ` — ${exclusion.effectiveUntil}` : ''}.`,
    };
  }
  if (todap) {
    return {
      ...base,
      regime: 'todap',
      governing: todap,
      headline: 'Governed by an HCD-approved TOD Alternative Plan',
      detail: `${cityName}’s TOD alternative plan governs instead of § 65912.157. Development standards come from the plan; the statutory figures below are for reference only.`,
    };
  }
  if (possibleExclusion) {
    return {
      ...base,
      regime: 'statute-unless-excluded',
      governing: possibleExclusion,
      headline: 'SB 79 standards apply unless the parcel is on the city’s exclusion list',
      detail: `${cityName} has an ordinance in force (${possibleExclusion.title}). Parcel-level coverage is not published as a queryable layer, so confirm with the city whether this parcel is excluded.`,
    };
  }
  return {
    ...base,
    regime: 'statute',
    headline: 'SB 79 statutory standards apply',
    detail: 'No local ordinance or HCD-approved TOD alternative plan in force covers this parcel, so Gov. Code § 65912.157 governs.',
  };
}

/** Plain-language yes/no answers for the two questions the site is built around. */
export function summarizeInstruments(regimeResult) {
  const ord = regimeResult.instruments.filter((i) => i.kind !== 'todap');
  const plans = regimeResult.instruments.filter((i) => i.kind === 'todap');
  const answer = (all) => {
    if (!all.length) return { subject: 'no', text: 'None on record' };
    const list = all.filter((i) => LOCAL_IN_FORCE.has(i.local?.status));
    if (!list.length) {
      const d = all[0];
      return {
        subject: 'pending',
        text: `In preparation (${d.local?.status || 'not adopted'}) — not in effect`,
        hcd: d.hcd?.status || 'unknown',
        hcdLabel: HCD_STATUS_LABEL[d.hcd?.status || 'unknown'],
        instrument: d,
      };
    }
    const covering = list.find((i) => i.covered === true);
    const maybe = list.find((i) => i.covered == null);
    const inst = covering || maybe || list[0];
    return {
      subject: covering ? 'yes' : maybe ? 'possibly' : 'no',
      text: covering ? 'Yes — parcel is covered' : maybe ? 'Jurisdiction has one; parcel coverage unconfirmed' : 'Jurisdiction has one, but this parcel is not covered',
      hcd: inst.hcd?.status || 'unknown',
      hcdLabel: HCD_STATUS_LABEL[inst.hcd?.status || 'unknown'],
      instrument: inst,
    };
  };
  return { delayOrdinance: answer(ord), todap: answer(plans) };
}
