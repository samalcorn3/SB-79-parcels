// Renders a parcel report object (from src/lib/lookup.js) to HTML.
import { HCD_STATUS_LABEL, KIND_LABEL } from '../lib/policy.js';
import { zoneCode } from '../lib/zones.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const BAND = { adjacent: '200 ft (adjacent)', quarter: '¼ mile', half: '½ mile' };
const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));

export function renderLoading(msg = 'Querying live sources…') {
  return `<div class="card loading"><span class="spinner"></span>${esc(msg)}</div>`;
}

export function renderError(message) {
  return `<div class="card"><div class="err">${esc(message)}</div></div>`;
}

export function renderNotOk(r) {
  const options = (r.suggestions || [])
    .map((x) => `<button type="button" data-text="${esc(x.text)}" data-magic="${esc(x.magicKey)}">${esc(x.text.replace(/, USA$/, ''))}</button>`)
    .join('');
  return `<div class="card"><h2>No result</h2><p>${esc(r.message)}</p>${options ? `<div class="didyoumean">${options}</div>` : ''}</div>`;
}

function zoneChips(zones) {
  if (!zones.length) return '<span class="chip none">Outside all TOD zones</span>';
  return zones
    .map((z) => `<span class="chip ${zoneCode(z)}" title="${esc(z.label)}">Tier ${z.tier} · ${esc(BAND[z.band])}${z.flags?.includes('commuter-rail-hcd-method') ? ' · CR*' : ''}</span>`)
    .join('');
}

function instrumentAnswer(title, a) {
  const inst = a.instrument;
  let hcd = '';
  if (inst) {
    const st = inst.hcd?.status || 'unknown';
    const date = inst.hcd?.date ? ` (${esc(inst.hcd.date)})` : '';
    const letter = inst.hcd?.letterUrl ? ` · ${link(inst.hcd.letterUrl, 'HCD letter')}` : '';
    const local = inst.local?.url ? ` · ${link(inst.local.url, inst.local.reference || 'adopted text')}` : inst.local?.reference ? ` · ${esc(inst.local.reference)}` : '';
    const verif = '';
    const docs = (inst.documents || [])
      .map((d) => `<li>${link(d.url, d.title)}${d.unread ? ` <span class="fine">— ${esc(d.unread)}</span>` : ''}</li>`)
      .join('');
    hcd = `<div class="hcd">
      <div><b>${esc(inst.title)}</b></div>
      <div>Local: ${esc(inst.local?.status || 'unknown')}${inst.local?.date ? ` ${esc(inst.local.date)}` : ''}${local}</div>
      <div>HCD: <span class="st ${esc(st)}">${esc(HCD_STATUS_LABEL[st] || st)}</span>${date}${letter}${verif}</div>
      ${inst.hcd?.conditions ? `<div class="fine">Condition: ${esc(inst.hcd.conditions)}</div>` : ''}
      ${inst.hcd?.note ? `<div class="fine">${esc(inst.hcd.note)}</div>` : ''}
      ${inst.coverageReason ? `<div class="fine">Why this parcel: ${esc(inst.coverageReason)}</div>` : ''}
      ${inst.covered !== true && inst.coverage?.note ? `<div class="fine">${esc(inst.coverage.note)}</div>` : ''}
      ${inst.coverage?.publisher && inst.covered != null ? `<div class="fine">Parcel coverage checked live against: ${link(inst.coverage.url, inst.coverage.publisher)}</div>` : ''}
      ${docs ? `<div class="fine">Primary sources:</div><ul class="plain fine">${docs}</ul>` : ''}
    </div>`;
  }
  return `<div class="qa-row"><div class="qa-q">${esc(title)}</div><span class="badge ${esc(a.subject)}">${esc(a.text)}</span>${hcd}</div>`;
}

function standardsCard(r, doc) {
  const s = r.standards;
  if (!s || !doc) return '';
  const binding = ['statute', 'statute-unless-excluded'].includes(r.regime.regime);
  const caption = binding
    ? 'What the city must allow under Gov. Code § 65912.157. Local limits may be higher, never lower.'
    : 'For reference: the § 65912.157 standards that would apply without the local instrument above.';
  const row = (label, key, unit) => {
    const m = s.max[key];
    const v = key === 'far' ? Number(m.value).toFixed(1) : fmt(m.value);
    return `<tr><th>${label}<div class="from">“${esc(doc.standardText[key])} …” — ${esc(m.cite)} · Tier ${m.from.tier}, ${esc(BAND[m.from.band])}</div></th><td class="num">${v}${unit}</td></tr>`;
  };
  const lot = s.lot;
  const g = doc.general;
  const aff = doc.affordability;
  const conc = doc.additionalConcessions;
  const lotLine = lot.maxUnits != null
    ? `<div class="lotcalc">On this ${fmt(r.parcel.lotSqFt)} sq ft lot (area computed from the parcel polygon): a qualifying project needs <b>at least ${fmt(lot.minUnits)} units</b> and may have <b>up to ${fmt(lot.maxUnits)} units</b> and <b>${fmt(lot.floorAreaSqFt)} net habitable sq ft</b> of residential floor area, before any density bonus.</div>`
    : '';
  const reqs = [
    `At least ${g.minUnits.value} dwelling units <span class="cite">${esc(g.minUnits.cite)}</span>`,
    `Minimum density of ${g.minDensityDuAc.value} du/ac, or the local zoning minimum if greater <span class="cite">${esc(g.minDensityDuAc.cite)}</span>`,
    `Average unit size no more than ${fmt(g.maxAvgUnitNetSqFt.value)} net habitable sq ft <span class="cite">${esc(g.maxAvgUnitNetSqFt.cite)}</span>`,
    lot.affordabilityApplies === false
      ? `Affordable set-aside not required for 10 or fewer units; above 10 units: ${aff.options.map((o) => `${o.pct}% ${esc(o.income.split(' (')[0])}`).join(', or ')} <span class="cite">${esc(aff.cite)}</span>`
      : `Affordable set-aside (projects over ${aff.appliesAboveUnits} units): ${aff.options.map((o) => `${o.pct}% ${esc(o.income.split(' (')[0])}`).join(', or ')}, for ${aff.termYears.rental} years (rental) / ${aff.termYears.ownership} years (ownership). ${esc(aff.localOverride)} <span class="cite">${esc(aff.cite)}</span>`,
    `Additional density-bonus concessions at ≥ ${fmt(s.concessionDensity.value)} du/ac${lot.concessionUnits != null ? ` (${fmt(lot.concessionUnits)} units here)` : ''}: ${conc.byIncome.map((c) => `${c.concessions} for ${esc(c.income)}`).join(', ')} <span class="cite">${esc(s.concessionDensity.cite)}(D); § 65912.157(d)</span>`,
    lot.laborStandardsPossible ? `Any building over ${doc.labor.heightFtOver} ft must meet the labor standards of § 65913.4(a)(8) <span class="cite">${esc(doc.labor.cite)}</span>` : null,
  ].filter(Boolean);
  const adj = s.rows.some((x) => x.intensifier)
    ? `<p class="fine">200-ft figures are the tier’s ¼-mile standards plus the adjacency intensifier: +${doc.adjacencyIntensifier.heightFt} ft, +${doc.adjacencyIntensifier.densityDuAc} du/ac, +${doc.adjacencyIntensifier.far.toFixed(1)} FAR, “prior to the application of Section 65915” (${esc(doc.adjacencyIntensifier.cite)}).</p>`
    : '';
  return `<div class="card"><h2>Height · Density · FAR</h2>
    <p class="fine">${esc(caption)}</p>
    <table class="std ${binding ? '' : 'reference'}">
      ${row('Height', 'heightFt', ' ft')}
      ${row('Density', 'densityDuAc', ' du/ac')}
      ${row('Residential FAR', 'far', '')}
    </table>${lotLine}${adj}
    ${s.rows.length > 1 ? `<p class="fine">The parcel is in ${s.rows.length} overlapping zones; each figure is the most permissive among them.</p>` : ''}
  </div>
  <div class="card"><h2>Project requirements</h2><ul class="plain">${reqs.map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
}

function fireCard(r) {
  const f = r.fire;
  if (!f) return '';
  const pctTxt = (x) => `${Math.round(x * 100)}%`;
  const rows = [
    `<li>Very High Fire Hazard Severity Zone: <b>${f.vhfhsz.hit ? `yes — ${pctTxt(f.vhfhsz.share)} of parcel` : 'no'}</b></li>`,
    `<li>State Responsibility Area: <b>${f.sra.hit ? `yes — ${pctTxt(f.sra.share)} of parcel` : 'no'}</b></li>`,
  ];
  const effects = f.vhfhsz.hit || f.sra.hit
    ? `${f.partial ? '<p class="warn">Only part of this parcel is in a fire zone. SB 79 and § 65913.4 refer to “sites within” a zone and do not say how a partly covered site is treated.</p>' : ''}<ul class="plain">
        <li>SB 79 still applies unless the city has adopted an ordinance excluding fire-zone sites. A city <i>may</i> temporarily exclude “sites within a very high fire hazard severity zone … or within the state responsibility area” until one year after its 7th-cycle housing element. <span class="cite">§ 65912.161(b)(1)(D)</span></li>
        <li>A TOD Alternative Plan may reduce density on this site by more than 50%. <span class="cite">§ 65912.161(a)(2)(A)</span></li>
        <li>Streamlined ministerial approval: § 65913.4(a)(6)(D) excludes sites in a VHFHSZ or the State Responsibility Area, but “does not apply to sites that have adopted fire hazard mitigation measures pursuant to existing building standards or state fire mitigation measures applicable to the development” (Pub. Res. Code §§ 4290, 4291; Gov. Code § 51182; Building Code ch. 7A). <span class="cite">§ 65912.159(a)(3); § 65913.4(a)(6)(D)</span></li>
        <li>Objective fire-safety standards (Building, Fire, and Wildland-Urban Interface Codes) apply. <span class="cite">§ 65912.157(j)</span></li>
      </ul>`
    : '<p class="fine">Not in a very high fire hazard severity zone or the State Responsibility Area, so the fire-zone exclusion in § 65912.161(b)(1)(D) cannot apply.</p>';
  return `<div class="card"><h2>Fire hazard</h2><ul class="plain">${rows.join('')}</ul>${effects}
    <p class="fine">Source: ${esc(f.publisher)} — Fire Hazard Severity Zone maps (LRA 2025, SRA v23.3), queried live.</p></div>`;
}


const AB_STATUS = { meets: ['✓', 'Meets'], fails: ['✗', 'Fails'], confirm: ['?', 'Confirm locally'], 'not-evaluated': ['–', 'Not yet evaluated'] };

export function ab2011Card(r) {
  const a = r.ab2011;
  if (a === undefined) return '<div class="card loading" id="ab2011-slot"><span class="spinner"></span>Checking AB 2011: measuring the street frontage and querying Caltrans and the Census Bureau…</div>';
  if (!a) return '';
  if (a.error) return `<div class="card"><h2>AB 2011</h2><div class="err">${esc(a.error)}</div></div>`;
  const path = (p) => `
    <details class="ab-path" ${p.status === 'fails' ? '' : 'open'}>
      <summary><span class="ab-badge ${esc(p.status)}">${p.status === 'fails' ? 'Not eligible' : p.status === 'meets' ? 'Eligible' : 'Possibly eligible'}</span> ${esc(p.title)}</summary>
      <ul class="ab-list">${p.criteria.map((c) => `<li class="ab-${esc(c.status)}"><span class="ab-mark" title="${esc(AB_STATUS[c.status][1])}">${AB_STATUS[c.status][0]}</span><div><b>${esc(c.text)}</b> <span class="cite">${esc(c.cite)}</span><div class="fine">${esc(c.detail)}</div></div></li>`).join('')}</ul>
    </details>`;
  const st = a.standards;
  const std = st ? `<table class="std"><tr><th>Density (metropolitan / other)<div class="from">${esc(st.density.basis)} — ${esc(st.density.cite)}</div></th><td class="num">${st.density.metropolitan} / ${st.density.other} du/ac</td></tr>
      <tr><th>Height<div class="from">corridor ${st.corridorWidthFt >= 100 ? '≥' : '<'} 100 ft — ${esc(st.heightFt.cite)}</div></th><td class="num">${st.heightFt.value}${st.heightFt.transitValue ? ` / ${st.heightFt.transitValue}` : ''} ft</td></tr></table>
      <p class="fine">${esc(st.density.note)} ${esc(st.heightFt.note)}</p>
      ${st.freewayWithin500Ft === 'yes' ? '<p class="warn">Within 500 ft of a freeway: air filtration (MERV 16), air intakes facing away from the freeway, and no balconies facing it (§ 65912.123(f)).</p>' : st.freewayWithin500Ft === 'possibly' ? '<p class="warn">Within 500 ft of a road Caltrans classes as “other freeway or expressway”; if it is a freeway, § 65912.123(f) ventilation and balcony rules apply.</p>' : ''}` : '';
  return `<div class="card"><h2>AB 2011 — housing on commercial land</h2>
    <p class="fine">${esc(a.statute)}. Statuses: ✓ decided from authoritative data · ✗ fails · ? depends on facts no public layer holds · – not yet evaluated.</p>
    ${path(a.paths.mixed)}${path(a.paths.affordable)}
    ${std ? `<h2 style="margin-top:12px">If eligible: mixed-income standards</h2>${std}` : ''}
    ${a.errors?.length ? `<div class="err">${a.errors.map(esc).join('<br>')}</div>` : ''}
  </div>`;
}

export function renderReport(r, { standardsDoc } = {}) {
  const p = r.parcel;
  const regime = r.regime;
  const zoning = r.zoning ? `<dt>Local zoning</dt><dd>${esc(r.zoning.code)}${r.zoning.description ? ` — ${esc(r.zoning.description)}` : ''}</dd>` : '';
  const warnings = [
    ...(p.stale ? p.sourceNotes : []),
    ...(r.mpo.draft ? [`${r.mpo.name} labels its SB 79 map as DRAFT.`] : []),
    ...(regime.notes || []),
    ...(r.zonesRemovedByPopulation?.length ? ['The ½-mile band was removed because the city has fewer than 35,000 residents.'] : []),
    ...(r.zones.some((z) => z.flags?.includes('commuter-rail-hcd-method')) ? ['CR* = commuter-rail zone qualifying under HCD’s advisory method (all services at a station counted together). The statute’s per-service reading may differ.'] : []),
    ...(r.zones.some((z) => z.flags?.includes('computed-adjacency')) ? ['200-ft adjacency computed from the MPO’s stop points, because this MPO does not publish a 200-ft layer.'] : []),
  ];
  const otherRules = r.provisions
    .filter((pv) => pv.id !== 'unincorporated' || !r.jurisdiction.incorporated)
    .map((pv) => `<li>${esc(pv.text)} <span class="cite">${esc(pv.cite)}</span></li>`)
    .join('');

  return `
  <div class="card">
    <p class="addr">${esc(p.address || r.input.geocoded?.label || 'Parcel')}</p>
    ${r.input.geocoded ? `<p class="matched">Your search “${esc(r.input.geocoded.query || '')}” matched <b>${esc(r.input.geocoded.label)}</b> (${esc(r.input.geocoded.type || 'match')}, score ${Math.round(r.input.geocoded.score)}).</p>` : ''}
    <dl class="kv">
      <dt>APN</dt><dd>${esc(p.apn || p.id || '—')}</dd>
      <dt>Jurisdiction</dt><dd>${esc(r.jurisdiction.name)}</dd>
      <dt>County</dt><dd>${esc(r.county.name)}</dd>
      <dt>Lot area</dt><dd>${fmt(p.lotSqFt)} sq ft</dd>
      ${p.use ? `<dt>Assessor use</dt><dd>${esc(p.use)}</dd>` : ''}
      ${zoning}
    </dl>
  </div>

  <div class="card verdict ${esc(regime.regime)}">
    <h3>${esc(regime.headline)}</h3>
    <p class="muted">${esc(regime.detail)}</p>
    ${warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
  </div>

  <div class="card"><h2>TOD zone</h2>
    <div class="chips">${zoneChips(r.zones)}</div>
    <p class="fine">Source: ${link(r.mpo.mapPage, r.mpo.name)} SB 79 map, queried live. Distance is measured from the nearest parcel edge to a pedestrian access point.</p>
  </div>

  <div class="card"><h2>Local instruments &amp; HCD review</h2>
    <div class="qa">
      ${instrumentAnswer('Subject to a delay / exclusion ordinance?', r.instrumentSummary.delayOrdinance)}
      ${instrumentAnswer('Subject to a TOD Alternative Plan?', r.instrumentSummary.todap)}
    </div>
    <p class="fine">Registry last reviewed ${esc(r.registryReviewed)}. ${link('https://www.hcd.ca.gov/hau/enforcement-letters', 'HCD letters dashboard')}</p>
  </div>

  ${fireCard(r)}

  ${ab2011Card(r)}

  ${standardsCard(r, standardsDoc)}

  <div class="card"><h2>Setbacks &amp; other statutory rules</h2><ul class="plain">${otherRules}</ul>
    ${standardsDoc ? `<p class="fine">Statute text: ${link(standardsDoc.source.url, 'Gov. Code § 65912.157 on leginfo')} — ${esc(standardsDoc.statute)}.</p>` : ''}
  </div>

  ${r.nearbyStops.length ? `<div class="card"><h2>TOD stops within ½ mile</h2><ul class="stops">${r.nearbyStops
    .map((s) => `<li><span>${esc(s.name)}${s.line ? ` <span class="fine">${esc(s.line)}</span>` : ''}</span><span class="fine">${s.tier ? `T${s.tier} · ` : ''}${fmt(s.distanceFt)} ft</span></li>`)
    .join('')}</ul></div>` : ''}

  <div class="card"><h2>Sources queried</h2>
    <ul class="plain fine">
      <li>Parcel: ${link(p.sourceUrl, p.publisher)}</li>
      <li>TOD zones &amp; stops: ${link(r.mpo.mapPage, r.mpo.name)}</li>
      <li>City/county limits: California Department of Technology</li>
      <li>Fire hazard zones: CAL FIRE — Office of the State Fire Marshal</li>
      <li>Generated ${esc(new Date(r.generatedAt).toLocaleString())}</li>
    </ul>
    ${r.errors.length ? `<div class="err">${r.errors.map(esc).join('<br>')}</div>` : ''}
    <p class="fine">Informational only — not a zoning determination or legal advice.</p>
  </div>`;
}

export { KIND_LABEL };
