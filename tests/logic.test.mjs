import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from '../scripts/load-data.mjs';
import { readSpec } from '../src/lib/spec.js';
import { normalizeZone, dedupeZones, applyPopulationRule } from '../src/lib/zones.js';
import { computeStandards, unitsForLot } from '../src/lib/standards.js';
import { determineRegime, instrumentInForce, summarizeInstruments, findJurisdiction } from '../src/lib/policy.js';
import { toEsriGeometry } from '../src/lib/arcgis.js';

const { sources, standards, registry } = await loadData();
const mpo = (id) => sources.mpos.find((m) => m.id === id);
const county = (id) => sources.counties.find((c) => c.id === id);

test('spec reader handles const, regex, map, numeric', () => {
  assert.equal(readSpec({ const: 2 }, {}), 2);
  assert.equal(readSpec({ field: 'T', regex: '(\\d)' }, { T: 'Tier 1' }), 1);
  assert.equal(readSpec({ field: 'B', map: { '200 Feet': 'adjacent' } }, { B: '200 feet' }), 'adjacent');
  assert.equal(readSpec({ field: 'B', map: { 'Half Mile': 'half' } }, { B: 'Tier 2 - Half Mile' }), 'half');
  assert.equal(readSpec({ field: 'd', numeric: [[0.04, 'adjacent'], [0.26, 'quarter'], [0.51, 'half']] }, { d: 0.0378788 }), 'adjacent');
  assert.equal(readSpec({ field: 'd', numeric: [[0.04, 'adjacent'], [0.26, 'quarter'], [0.51, 'half']] }, { d: 0.5 }), 'half');
  assert.equal(readSpec({ field: 'missing' }, {}), undefined);
});

test('SCAG zone attributes normalize (incl. commuter-rail flag)', () => {
  const layer = mpo('scag').zoneLayers[0];
  assert.deepEqual(
    normalizeZone(layer, { TIER: 'Tier 1', BUFFER: '0.25 Miles', NAME: 'Tier 1 - 0.25 Miles' }, 'scag'),
    { mpo: 'scag', tier: 1, band: 'quarter', label: 'Tier 1 - 0.25 Miles', flags: [] },
  );
  const cr = normalizeZone(layer, { TIER: 'Tier 2', BUFFER: '200 Feet', NAME: 'Tier 2 - 200 Feet (Commuter Rail)' }, 'scag');
  assert.equal(cr.band, 'adjacent');
  assert.deepEqual(cr.flags, ['commuter-rail-hcd-method']);
});

test('MTC, SANDAG and SACOG zone attributes normalize', () => {
  const m = mpo('mtc').zoneLayers[0];
  assert.equal(normalizeZone(m, { zone_label: 'Tier 1 - 200ft' }, 'mtc').band, 'adjacent');
  assert.equal(normalizeZone(m, { zone_label: 'Tier 2 - Quarter Mile' }, 'mtc').tier, 2);
  assert.equal(normalizeZone(m, { zone_label: 'Tier 2 - Half Mile' }, 'mtc').band, 'half');
  const [q, h] = mpo('sandag').zoneLayers;
  assert.deepEqual([normalizeZone(q, { Tier: 2 }, 'sandag').band, normalizeZone(h, { Tier: 1 }, 'sandag').tier], ['quarter', 1]);
  const s = mpo('sacog').zoneLayers[0];
  assert.deepEqual(normalizeZone(s, { buff_dist: 0.25 }, 'sacog'), { mpo: 'sacog', tier: 2, band: 'quarter', label: 'Tier 2 – quarter', flags: [] });
});

test('uninterpretable zone attributes are rejected, not guessed', () => {
  assert.equal(normalizeZone(mpo('mtc').zoneLayers[0], { zone_label: 'Something else' }, 'mtc'), null);
});

test('dedupe sorts best zone first (Tier 1 before Tier 2, nearer band first)', () => {
  const z = dedupeZones([
    { tier: 2, band: 'adjacent', flags: [] },
    { tier: 1, band: 'half', flags: [] },
    { tier: 1, band: 'quarter', flags: [] },
    { tier: 1, band: 'quarter', flags: [] },
  ]);
  assert.deepEqual(z.map((x) => `${x.tier}${x.band}`), ['1quarter', '1half', '2adjacent']);
});

test('½-mile band dropped for cities under 35,000 only when population is known', () => {
  const zones = [{ tier: 2, band: 'half' }, { tier: 2, band: 'quarter' }];
  assert.equal(applyPopulationRule(zones, 20000).zones.length, 1);
  assert.equal(applyPopulationRule(zones, 50000).zones.length, 2);
  assert.equal(applyPopulationRule(zones, null).zones.length, 2);
});

test('standards match HCD Table 1 and take the most permissive applicable zone', () => {
  const s = computeStandards(standards, [{ tier: 1, band: 'quarter' }, { tier: 2, band: 'adjacent' }]);
  assert.equal(s.max.heightFt.value, 85); // Tier 2 adjacent (85) beats Tier 1 quarter (75)
  assert.equal(s.max.densityDuAc.value, 140);
  assert.equal(s.max.far.value, 4.0);
  const t1 = computeStandards(standards, [{ tier: 1, band: 'adjacent' }]);
  assert.deepEqual([t1.max.heightFt.value, t1.max.densityDuAc.value, t1.max.far.value], [95, 160, 4.5]);
  const t2h = computeStandards(standards, [{ tier: 2, band: 'half' }]);
  assert.deepEqual([t2h.max.heightFt.value, t2h.max.densityDuAc.value, t2h.max.far.value], [55, 80, 2.5]);
  assert.equal(computeStandards(standards, []), null);
  assert.equal(unitsForLot(100, 43560), 100);
});

test('TODAP governs only once HCD approves it', () => {
  assert.equal(instrumentInForce({ kind: 'todap', local: { status: 'enacted' }, hcd: { status: 'compliant' } }).inForce, true);
  assert.equal(instrumentInForce({ kind: 'todap', local: { status: 'enacted' }, hcd: { status: 'pending' } }).inForce, false);
  assert.equal(instrumentInForce({ kind: 'todap', local: { status: 'draft' }, hcd: { status: 'compliant' } }).inForce, false);
});

test('ordinance governs unless HCD finds it noncompliant', () => {
  assert.equal(instrumentInForce({ kind: 'exclusion-ordinance', local: { status: 'enacted' }, hcd: { status: 'unknown' } }).inForce, true);
  assert.equal(instrumentInForce({ kind: 'exclusion-ordinance', local: { status: 'enacted' }, hcd: { status: 'noncompliant' } }).inForce, false);
});

const T1Q = [{ tier: 1, band: 'quarter', flags: [] }];

test('regime: not in zone / pending county / unincorporated', () => {
  assert.equal(determineRegime({ zones: [], county: county('alameda'), jurisdiction: null, cityName: 'Oakland' }).regime, 'not-in-zone');
  assert.match(determineRegime({ zones: [], county: county('orange'), jurisdiction: null, cityName: 'Irvine' }).headline, /not yet in effect/);
  assert.equal(determineRegime({ zones: T1Q, county: county('alameda'), jurisdiction: null, cityName: null }).regime, 'not-yet-applicable');
});

test('regime: San Francisco — TODAP governs, exclusion layer overrides', () => {
  const sf = findJurisdiction(registry, 'San Francisco');
  const notExcluded = determineRegime({ zones: T1Q, county: county('san-francisco'), jurisdiction: sf, cityName: 'San Francisco', coverage: { 'sf-exclusions-2026': { covered: false } } });
  assert.equal(notExcluded.regime, 'todap');
  const excluded = determineRegime({ zones: T1Q, county: county('san-francisco'), jurisdiction: sf, cityName: 'San Francisco', coverage: { 'sf-exclusions-2026': { covered: true, reason: 'Low Resource Tract' } } });
  assert.equal(excluded.regime, 'excluded');
  const sum = summarizeInstruments(excluded);
  assert.equal(sum.delayOrdinance.subject, 'yes');
  assert.equal(sum.delayOrdinance.hcd, 'compliant');
});

test('regime: HCD-rejected TODAP falls back to the statute', () => {
  const bh = findJurisdiction(registry, 'beverly hills');
  const r = determineRegime({ zones: T1Q, county: county('los-angeles'), jurisdiction: bh, cityName: 'Beverly Hills' });
  assert.equal(r.regime, 'statute');
  assert.equal(summarizeInstruments(r).todap.hcd, 'noncompliant');
});

test('regime: ordinance with unpublished coverage is flagged, not assumed', () => {
  const oak = findJurisdiction(registry, 'Oakland');
  assert.equal(determineRegime({ zones: T1Q, county: county('alameda'), jurisdiction: oak, cityName: 'Oakland' }).regime, 'statute-unless-excluded');
});

test('regime: draft TODAP is reported as pending, not as covering', () => {
  const sd = findJurisdiction(registry, 'San Diego');
  const r = determineRegime({ zones: T1Q, county: county('san-diego'), jurisdiction: sd, cityName: 'San Diego' });
  assert.equal(summarizeInstruments(r).todap.subject, 'pending');
});

test('GeoJSON -> Esri geometry', () => {
  assert.deepEqual(toEsriGeometry({ type: 'Point', coordinates: [-118, 34] }).geometry, { x: -118, y: 34, spatialReference: { wkid: 4326 } });
  const mp = toEsriGeometry({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[2, 2], [3, 2], [3, 3], [2, 2]]]] });
  assert.equal(mp.geometry.rings.length, 2);
});

test('registry entries are well-formed', () => {
  const kinds = new Set(['todap', 'exclusion-ordinance', 'implementing-ordinance']);
  const hcd = new Set(['compliant', 'noncompliant', 'pending', 'technical-assistance', 'not-submitted', 'unknown']);
  const countyIds = new Set(sources.counties.map((c) => c.id));
  for (const [name, j] of Object.entries(registry.jurisdictions)) {
    assert.ok(countyIds.has(j.county), `${name}: unknown county ${j.county}`);
    for (const i of j.instruments) {
      assert.ok(kinds.has(i.kind), `${i.id}: kind`);
      assert.ok(hcd.has(i.hcd?.status), `${i.id}: hcd.status`);
      assert.ok(['primary', 'secondary'].includes(i.verification), `${i.id}: verification`);
      assert.ok(['jurisdiction-wide', 'arcgis', 'unknown'].includes(i.coverage?.type), `${i.id}: coverage`);
      if (i.verification === 'secondary') assert.ok(i.sources?.length, `${i.id}: secondary entries must cite sources`);
    }
  }
});
