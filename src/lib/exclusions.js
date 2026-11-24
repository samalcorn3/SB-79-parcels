// Site exclusions of Gov. Code § 65913.4(a)(6)(A)–(K), checked against each
// agency's own live map.
//
// Which laws apply them:
//   SB 79   — only to projects using streamlined ministerial approval
//             (§ 65912.159(a)(3): "shall comply with all other requirements of
//             Section 65913.4"). A project reviewed under the city's ordinary
//             process (§ 65912.159(b)) is not subject to them.
//   AB 2011 — both paths (§ 65912.111(e); § 65912.121(g)), "exclusive of
//             clause (iv) of subparagraph (A)" (coastal parcels not zoned for
//             multifamily housing).
//
// Statuses (same vocabulary as the AB 2011 criteria):
//   'meets'        not excluded — decided from the map the statute names
//                  (FEMA, State Geologist, FMMP, Coastal Commission, Fire Marshal)
//   'none-mapped'  the agency's map shows nothing here, but the statutory test is
//                  broader than the map (wetland definition, habitat, easements…)
//   'confirm'      the map shows a constraint, but an exception or a fact outside
//                  the map decides it (e.g. a FEMA Letter of Map Revision)
//   'fails'        excluded
//   'not-evaluated' the source could not be queried, or has no data here
import { queryIntersecting, toEsriGeometry, getJSON } from './arcgis.js';
import { getField } from './spec.js';

const CITE = '§ 65913.4(a)(6)';
// Agency servers are queried in parallel; a slow one is reported as not evaluated rather than holding up the report.
const REQUEST = { timeoutMs: 15000, retries: 1 };
const q = (url, geo, opts = {}) => queryIntersecting(url, geo, { ...opts, request: REQUEST });
const item = (id, sub, title, status, detail, src, extra = {}) => ({ id, sub, cite: `${CITE}(${sub})`, title, status, detail, source: src, ...extra });

/** Intersecting features, plus whether one of them wholly contains the parcel. */
async function hitTest(url, geo, { where = '1=1', outFields = ['OBJECTID'] } = {}) {
  const [rows, within] = await Promise.all([
    q(url, geo, { where, outFields }),
    // esriSpatialRelWithin: the query geometry (the parcel) lies wholly within a feature.
    q(url, geo, { where, outFields, extra: { spatialRel: 'esriSpatialRelWithin' } }).catch(() => null),
  ]);
  return { rows, hit: rows.length > 0, whole: within ? within.length > 0 : null };
}

const farmlandLayerCache = new Map();
/** Newest FMMP survey year, discovered from the server's folder listing so new releases are picked up automatically. */
export function latestFarmlandLayer(cfg) {
  if (!farmlandLayerCache.has(cfg.folder)) {
    farmlandLayerCache.set(cfg.folder, getJSON(cfg.folder, { f: 'json' }).then((json) => {
      const re = new RegExp(cfg.servicePattern);
      const years = (json.services || [])
        .filter((s) => s.type === 'FeatureServer' || s.type === 'MapServer')
        .map((s) => ({ m: re.exec(s.name), s }))
        .filter((x) => x.m)
        .map((x) => ({ year: Number(x.m[1]), name: x.s.name, type: x.s.type }))
        .sort((a, b) => b.year - a.year || (a.type === 'FeatureServer' ? -1 : 1));
      if (!years.length) throw new Error('No Important Farmland service found');
      const base = cfg.folder.replace(/\/services\/.*$/, '/services');
      return { year: years[0].year, url: `${base}/${years[0].name}/${years[0].type}/${cfg.layer}` };
    }).catch((e) => {
      farmlandLayerCache.delete(cfg.folder);
      throw e;
    }));
  }
  return farmlandLayerCache.get(cfg.folder);
}

/**
 * § 65913.4(a)(6)(A)(ii) — is the coastal-zone site subject to a certified LCP or certified land use plan?
 * From the Coastal Commission's LCP segment attributes.
 */
export function lcpCertification(a) {
  const f = (k) => String(a?.[k] ?? '').trim();
  if (!a) return { status: 'confirm', text: 'LCP certification status not found.' };
  if (f('UncertArea') === 'Y') return { status: 'confirm', text: `“${f('Name')}” is an area of deferred certification, which is generally not subject to a certified LCP (clause (ii)).` };
  if (f('LCPCert') === 'Y' || f('Effec_Cert') === 'Y') return { status: 'ok', text: `${f('Name')}: certified Local Coastal Program.` };
  if (a.LUPDate) return { status: 'ok', text: `${f('Name')}: certified Land Use Plan, LCP not yet fully certified.` };
  if (f('NonLCP') === 'Y') return { status: 'confirm', text: `${f('Name')}: federal or tribal land outside the LCP program.` };
  return { status: 'fails', text: `${f('Name')}: neither a certified LCP nor a certified Land Use Plan, so clause (ii) excludes the site.` };
}

const share = (h) => (h.whole ? 'The whole parcel is' : 'Part of the parcel is');

/** Coastal zone (A): in/out from the Commission's boundary; certification from its LCP segments. */
async function coastal(cfg, geo) {
  const src = { name: cfg.coastalZone.publisher, url: cfg.coastalZone.url };
  const cz = await hitTest(cfg.coastalZone.url, geo, { outFields: cfg.coastalZone.fields });
  if (!cz.hit) {
    return item('coastal', 'A', 'Not in the coastal zone', 'meets', 'Outside the coastal zone (Coastal Commission boundary), so none of clauses (A)(i)–(v) can apply.', src, { inCoastalZone: false });
  }
  const segs = await q(cfg.lcpSegments.url, geo, { outFields: cfg.lcpSegments.fields }).catch(() => []);
  const seg = segs[0] || null;
  const cert = lcpCertification(seg && Object.fromEntries(cfg.lcpSegments.fields.map((k) => [k, getField(seg, k)])));
  const f = (k) => (seg ? String(getField(seg, k) ?? '').trim() : '');

  const rest = 'Also excluded in the coastal zone: (i) the Commission’s appeal jurisdiction under Pub. Res. Code § 30603(a)(1)–(2) (between the sea and the first public road, within 300 ft of a beach or coastal bluff, or within 100 ft of a wetland or stream); (iii) land vulnerable to five feet of sea-level rise (NOAA, OPC, USGS, UC, or the city’s vulnerability assessment); (v) on or within 100 ft of a wetland, or on prime agricultural land. Clause (iv), parcels not zoned for multifamily housing, applies to SB 79 but not to AB 2011.';
  return item('coastal', 'A', 'Coastal zone exclusions', cert.status === 'fails' ? 'fails' : 'confirm',
    `${share(cz)} in the coastal zone. ${cert.text} ${rest}${cz.whole ? '' : ' Near the boundary, the Commission’s adopted maps decide; ask it for a boundary determination.'}`,
    src, { inCoastalZone: true, lcp: seg ? f('Name') : null });
}

async function farmland(cfg, geo) {
  const layer = await latestFarmlandLayer(cfg.farmland);
  const src = { name: `${cfg.farmland.publisher}, ${layer.year} survey`, url: layer.url };
  const h = await hitTest(layer.url, geo, { where: cfg.farmland.where, outFields: cfg.farmland.fields });
  const ballot = 'Land zoned or designated for agricultural protection by a local ballot measure is also excluded; that is not mapped statewide.';
  if (!h.hit) return item('farmland', 'B', 'Not prime farmland or farmland of statewide importance', 'meets', `No Prime Farmland or Farmland of Statewide Importance on the ${layer.year} Important Farmland map. ${ballot}`, src);
  const kinds = [...new Set(h.rows.map((r) => (getField(r, 'polygon_ty') === 'P' ? 'Prime Farmland' : 'Farmland of Statewide Importance')))].join(' and ');
  return item('farmland', 'B', 'Prime farmland or farmland of statewide importance', h.whole ? 'fails' : 'confirm',
    `${share(h)} mapped as ${kinds} (${layer.year}).${h.whole ? '' : ' The statute does not say how a partly covered site is treated.'}`, src);
}

async function wetlands(cfg, geo) {
  const w = cfg.wetlands;
  const via = '';
  const rows = await q(w.url, geo, { outFields: w.fields });
  const src = { name: w.publisher, url: w.url };
  const h = { rows, hit: rows.length > 0, whole: false };
  const def = 'The test is the definition in the USFWS Manual, Part 660 FW 2 (June 21, 1993), not the map; the National Wetlands Inventory is mapped from imagery and is not a field delineation.';
  if (!h.hit) return item('wetlands', 'C', 'Not wetlands', 'none-mapped', `No wetland mapped on the parcel in the National Wetlands Inventory${via}. ${def}`, src);
  const kinds = [...new Set(h.rows.map((r) => `${getField(r, 'WETLAND_TYPE')} (${getField(r, 'ATTRIBUTE')})`))].join('; ');
  return item('wetlands', 'C', 'Wetlands', 'confirm', `The parcel includes land mapped in the National Wetlands Inventory${via}: ${kinds}. ${def} A biologist’s delineation decides.`, src);
}

async function hazardous(cfg, geo) {
  const c = cfg.hazardous;
  const src = { name: c.publisher, url: c.layers[0].url };
  const found = (await Promise.all(c.layers.map(async (l) => {
    const rows = await q(l.url, geo, { outFields: l.fields });
    return rows.map((r) => {
      const [name, type, status, id] = l.fields.map((k) => getField(r, k));
      return { kind: l.label, name, type, status, id, link: l.fields[3] === 'envirostor_id' && id ? `${c.profileUrl}${id}` : null };
    });
  }))).flat();
  const rest = `${c.note} Check CalEPA’s Cortese list.`;
  if (!found.length) {
    return item('hazardous', 'E', 'Not a listed hazardous waste site', 'none-mapped', `No DTSC EnviroStor site or hazardous waste facility is located on the parcel. ${rest}`, src, { links: [{ label: 'Cortese list', url: c.corteseUrl }] });
  }
  const list = found.map((s) => `${s.name} — ${s.type}, ${s.status} (${s.kind})`).join('; ');
  return item('hazardous', 'E', 'Hazardous waste site', 'confirm',
    `DTSC EnviroStor locates on this parcel: ${list}. Excluded if the site is on the § 65962.5 list or designated under Health & Safety Code § 25356, unless a closure letter or a suitability determination for residential use applies (clauses (i)–(ii)). EnviroStor points are approximate. ${rest}`,
    src, { sites: found, links: [...found.filter((s) => s.link).map((s) => ({ label: s.name, url: s.link })), { label: 'Cortese list', url: c.corteseUrl }] });
}

async function fault(cfg, geo) {
  const src = { name: cfg.faultZones.publisher, url: cfg.faultZones.url };
  const h = await hitTest(cfg.faultZones.url, geo, { outFields: cfg.faultZones.fields });
  if (!h.hit) return item('fault', 'F', 'Not in an earthquake fault zone', 'meets', 'Outside every Alquist-Priolo Earthquake Fault Zone mapped by the State Geologist.', src);
  const report = String(getField(h.rows[0], 'REPORTLINK') || '').split(';')[0].trim();
  return item('fault', 'F', 'Earthquake fault zone', 'confirm',
    `${share(h)} in an Alquist-Priolo Earthquake Fault Zone. The exclusion does not apply if the development complies with applicable seismic protection building code standards (Health & Safety Code § 18901 et seq.; Gov. Code § 8875 et seq.). Building in a fault zone requires a site-specific fault investigation (Pub. Res. Code § 2623).`,
    src, { links: report ? [{ label: 'Fault evaluation report', url: report }] : [] });
}

/** Flood (G) and floodway (H) both come from FEMA's flood hazard zones. */
async function flood(cfg, geo) {
  const src = { name: cfg.flood.publisher, url: cfg.flood.url };
  const rows = await q(cfg.flood.url, geo, { outFields: cfg.flood.fields });
  if (!rows.length) {
    const none = 'FEMA has no digital flood map (NFHL) here; check the paper Flood Insurance Rate Map.';
    return [item('flood', 'G', 'Not in a special flood hazard area', 'not-evaluated', none, src), item('floodway', 'H', 'Not in a regulatory floodway', 'not-evaluated', none, src)];
  }
  const sfha = rows.filter((r) => getField(r, 'SFHA_TF') === 'T');
  const fw = rows.filter((r) => /FLOODWAY/i.test(String(getField(r, 'ZONE_SUBTY') || '')));
  const zones = [...new Set(rows.map((r) => getField(r, 'FLD_ZONE')))].join(', ');
  const g = sfha.length
    ? item('flood', 'G', 'Special flood hazard area (100-year flood)', 'confirm',
      `In FEMA zone ${[...new Set(sfha.map((r) => getField(r, 'FLD_ZONE')))].join(', ')} (special flood hazard area). Allowed only if FEMA has issued a Letter of Map Revision for the site, or the site meets the National Flood Insurance Program’s minimum floodplain management criteria (44 C.F.R. parts 59–60). If it does, the city may not deny the project for failing to meet additional local flood requirements.`, src)
    : item('flood', 'G', 'Not in a special flood hazard area', 'meets', `FEMA zone ${zones} — outside the 1-percent-annual-chance (100-year) floodplain.`, src);
  const h = fw.length
    ? item('floodway', 'H', 'Regulatory floodway', 'confirm', 'Part of the parcel is in a FEMA regulatory floodway. Allowed only with a no-rise certification under 44 C.F.R. § 60.3(d)(3).', src)
    : item('floodway', 'H', 'Not in a regulatory floodway', 'meets', 'No FEMA regulatory floodway on the parcel.', src);
  return [g, h];
}

async function conservationPlans(cfg, geo) {
  const src = { name: cfg.conservationPlans.publisher, url: cfg.conservationPlans.url };
  const rows = await q(cfg.conservationPlans.url, geo, { outFields: cfg.conservationPlans.fields });
  if (!rows.length) {
    return item('conservation-plan', 'I', 'Not land identified for conservation in an adopted plan', 'none-mapped',
      'Not inside any NCCP or HCP plan area mapped by CDFW. Habitat conservation plans approved only by USFWS, and other adopted natural resource protection plans, are not all in this layer.', src);
  }
  const plans = rows.map((r) => `${getField(r, 'Display_Name')} (${[getField(r, 'Plan_Type'), getField(r, 'Plan_Stage')].filter(Boolean).join(', ')})`).join('; ');
  return item('conservation-plan', 'I', 'Land identified for conservation in an adopted plan', 'confirm',
    `Inside the plan area of: ${plans}. Only land the plan identifies for conservation is excluded, not the whole plan area; check the plan’s reserve or preserve maps.`,
    src, { links: rows.map((r) => getField(r, 'Website')).filter(Boolean).map((u, i) => ({ label: getField(rows[i], 'Display_Name'), url: u })) });
}

async function habitat(cfg, geo) {
  const src = { name: cfg.criticalHabitat.publisher, url: cfg.criticalHabitat.url };
  const rows = await q(cfg.criticalHabitat.url, geo, { outFields: cfg.criticalHabitat.fields });
  const scope = 'The exclusion covers habitat for any candidate, sensitive, special-status, fully protected, or listed species, which is broader than designated critical habitat; a biological survey decides.';
  if (!rows.length) return item('habitat', 'J', 'Not habitat for protected species', 'none-mapped', `No federally designated critical habitat on the parcel. ${scope}`, src);
  const sp = [...new Set(rows.map((r) => `${getField(r, 'comname')} (${getField(r, 'listing_status')})`))].join('; ');
  return item('habitat', 'J', 'Habitat for protected species', 'confirm', `In designated critical habitat for: ${sp}. ${scope}`, src);
}

async function easements(cfg, geo) {
  const src = { name: cfg.agEasements.publisher, url: cfg.agEasements.url };
  const h = await hitTest(cfg.agEasements.url, geo, { outFields: cfg.agEasements.fields });
  const title = 'Conservation easements are recorded with the county recorder; a preliminary title report shows them.';
  if (!h.hit) return item('easement', 'K', 'Not under a conservation easement', 'none-mapped', `No agricultural conservation easement funded through the Department of Conservation on the parcel. ${title}`, src);
  const holders = [...new Set(h.rows.map((r) => getField(r, 'HOLDER')).filter(Boolean))].join(', ');
  return item('easement', 'K', 'Under a conservation easement', h.whole ? 'fails' : 'confirm', `${share(h)} under an agricultural conservation easement${holders ? ` held by ${holders}` : ''}. ${title}`, src);
}

function fireItem(fire, fireSrc) {
  const src = { name: fireSrc?.publisher || 'CAL FIRE — Office of the State Fire Marshal', url: fireSrc?.vhfhsz?.url };
  if (!fire) return item('fire', 'D', 'Not in a very high fire hazard severity zone or the state responsibility area', 'not-evaluated', 'Fire-zone check unavailable.', src);
  if (!fire.vhfhsz.hit && !fire.sra.hit) return item('fire', 'D', 'Not in a very high fire hazard severity zone or the state responsibility area', 'meets', 'Outside both (State Fire Marshal maps).', src);
  return item('fire', 'D', 'Very high fire hazard severity zone or state responsibility area', 'confirm',
    `${fire.vhfhsz.hit ? `${Math.round(fire.vhfhsz.share * 100)}% in a VHFHSZ. ` : ''}${fire.sra.hit ? `${Math.round(fire.sra.share * 100)}% in the SRA. ` : ''}The exclusion “does not apply to sites that have adopted fire hazard mitigation measures pursuant to existing building standards or state fire mitigation measures applicable to the development” (Pub. Res. Code §§ 4290, 4291; Gov. Code § 51182; Building Code ch. 7A).`, src);
}

/** Overall status of a list: any 'fails' fails; all 'meets' meets; otherwise needs confirmation. */
export function exclusionsStatus(items) {
  if (items.some((i) => i.status === 'fails')) return 'fails';
  if (items.every((i) => i.status === 'meets')) return 'meets';
  return 'confirm';
}

/**
 * All § 65913.4(a)(6) checks for one parcel.
 * @param data  { sources }
 * @param ctx   { parcel (GeoJSON Feature), fire (fireStatus result) }
 * @returns { items: [...], status, errors }
 */
export async function siteExclusionsForParcel(data, { parcel, fire }) {
  const cfg = data.sources.siteExclusions;
  const geo = toEsriGeometry(parcel.geometry);
  const errors = [];
  const guard = (id, sub, title, fn) => fn().catch((e) => {
    errors.push(`${title}: ${e.message}`);
    return item(id, sub, title, 'not-evaluated', `Source did not respond (${e.message}).`, null);
  });
  const results = await Promise.all([
    guard('coastal', 'A', 'Coastal zone', () => coastal(cfg, geo)),
    guard('farmland', 'B', 'Farmland', () => farmland(cfg, geo)),
    guard('wetlands', 'C', 'Wetlands', () => wetlands(cfg, geo)),
    Promise.resolve(fireItem(fire, data.sources.fireHazard)),
    guard('hazardous', 'E', 'Hazardous waste site', () => hazardous(cfg, geo)),
    guard('fault', 'F', 'Earthquake fault zone', () => fault(cfg, geo)),
    guard('flood', 'G', 'Flood hazard area and floodway', () => flood(cfg, geo)),
    guard('conservation-plan', 'I', 'Conservation plan lands', () => conservationPlans(cfg, geo)),
    guard('habitat', 'J', 'Protected-species habitat', () => habitat(cfg, geo)),
    guard('easement', 'K', 'Conservation easement', () => easements(cfg, geo)),
  ]);
  const items = results.flat();
  // A failed flood query yields one item; split it so (G) and (H) both appear.
  if (!items.some((i) => i.id === 'floodway')) {
    const g = items.find((i) => i.id === 'flood');
    items.splice(items.indexOf(g) + 1, 0, { ...g, id: 'floodway', sub: 'H', cite: `${CITE}(H)`, title: 'Regulatory floodway' });
  }
  return { statute: cfg.statute, items, status: exclusionsStatus(items), errors };
}

/**
 * The same checks as one law applies them. AB 2011 (§§ 65912.111(e), 65912.121(g))
 * excludes clause (A)(iv); its coastal item is rephrased accordingly.
 */
export function exclusionsFor(law, result) {
  if (!result) return [];
  if (law === 'ab2011') {
    return result.items.map((i) => ({
      ...i,
      cite: `§ 65912.111(e); § 65912.121(g) → ${i.cite}${i.id === 'coastal' ? ' (except (A)(iv))' : ''}`,
      detail: i.id === 'coastal' ? i.detail.replace(/ Clause \(iv\)[^.]*\./, '') : i.detail,
    }));
  }
  return result.items.map((i) => ({ ...i, cite: `§ 65912.159(a)(3) → ${i.cite}` }));
}
