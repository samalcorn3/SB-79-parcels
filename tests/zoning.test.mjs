// Zoning rules for AB 2011's "zone where office, retail, or parking are a principally permitted use".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickZoningSource, classifyZone, combineZoneStatuses, loadZoningSource, limitsFromText, provenance, urlFrom, layerUpdatedInfo, CURRENT_SINCE } from '../src/lib/zoning.js';
import { loadData, loadZoningSources } from '../scripts/load-data.mjs';

const { zoning } = await loadData();
zoning.sources = await loadZoningSources();
const s101 = await readFile(new URL('../data/statute/65912.101.txt', import.meta.url), 'utf8');
const src = (id) => zoning.sources.find((s) => s.id === id);
const cls = (id, z) => classifyZone(zoning, src(id), z);

test('§ 65912.101(u): parking counts whether or not it needs a conditional use permit', () => {
  assert.match(s101, /parking uses\s+are considered principally permitted whether or not they require a conditional use permit/);
  assert.equal(zoning.classes.parking.status, 'meets');
  assert.match(zoning.classes.residential.why, /65912\.101\(u\)/);
});

test('registry is well formed', () => {
  const statuses = new Set(['meets', 'fails', 'confirm']);
  for (const [k, c] of Object.entries(zoning.classes)) assert.ok(statuses.has(c.status), k);
  for (const s of zoning.sources) {
    assert.ok(s.url || s.fromParcel, `${s.id} has no layer`);
    assert.ok(s.fields || s.fromParcel, `${s.id} has no fields`);
    assert.ok(s.jurisdictions || s.unincorporatedOf || s.regionalFor, `${s.id} applies nowhere`);
    for (const r of s.rules) {
      assert.ok(zoning.classes[r.class], `${s.id}: unknown class ${r.class}`);
      assert.doesNotThrow(() => new RegExp(r.match), `${s.id}: bad regex ${r.match}`);
      if (r.on === 'category') assert.ok(s.fields?.category, `${s.id}: category rule without a category field`);
    }
    assert.ok(!s.regional && !s.regionalFor, `${s.id}: regional compilations are not allowed`);
  }
});

test('index lists every jurisdiction file, and files load only on request', async () => {
  assert.deepEqual(zoning.index.map((e) => e.id), zoning.sources.map((s) => s.id));
  for (const e of zoning.index) {
    const s = src(e.id);
    assert.deepEqual(e.jurisdictions, s.jurisdictions, e.id);
    assert.equal(e.unincorporatedOf, s.unincorporatedOf, e.id);
    assert.ok(!('url' in e) && !('rules' in e), `${e.id}: the index carries no layer or rules`);
  }
  const requested = [];
  const lazy = { ...zoning, loadSource: async (id) => { requested.push(id); return src(id); } };
  const a = await loadZoningSource(lazy, 'pasadena');
  await loadZoningSource(lazy, 'pasadena');
  assert.equal(a.url, src('pasadena').url);
  assert.deepEqual(requested, ['pasadena']); // fetched once, and nothing else
});

test('source choice: the city’s own layer, or the county’s for unincorporated land; nothing else', () => {
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: 'Los Angeles' }).id, 'la-city');
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: null }).id, 'la-county');
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: 'Carson' }), null); // no regional compilations
  assert.equal(pickZoningSource(zoning, { countyId: 'santa-clara', cityName: 'San José' }).id, 'sj-city');
  assert.equal(pickZoningSource(zoning, { countyId: 'alameda', cityName: 'Pleasanton' }).id, 'pleasanton');
  assert.equal(pickZoningSource(zoning, { countyId: 'alameda', cityName: 'Berkeley' }).id, 'berkeley'); // third-party copy, last resort
  assert.equal(pickZoningSource(zoning, { countyId: 'alameda', cityName: 'Piedmont' }), null);
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: 'Torrance' }).id, 'torrance'); // known gaps: never decides outright
  assert.equal(pickZoningSource(zoning, { countyId: 'san-diego', cityName: null }).id, 'sd-county');
  assert.equal(pickZoningSource(zoning, { countyId: 'san-diego', cityName: 'Carlsbad' }).id, 'carlsbad');
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: 'Santa Clarita' }), null);
  assert.equal(pickZoningSource(zoning, { countyId: 'sacramento', cityName: null }).id, 'sacramento-county');
  assert.equal(pickZoningSource(zoning, { countyId: 'orange', cityName: null }).id, 'orange-county');
  assert.equal(pickZoningSource(zoning, { countyId: 'orange', cityName: 'Anaheim' }).id, 'anaheim');
  assert.equal(pickZoningSource(zoning, { countyId: 'alameda', cityName: null }), null); // only a draft layer is published
});

test('zone classification', () => {
  assert.equal(cls('la-city', { code: 'C4-2', category: 'Commercial' }).status, 'meets');
  assert.equal(cls('la-city', { code: 'P-2', category: 'Parking' }).status, 'meets');
  assert.equal(cls('la-city', { code: 'M2-1', category: 'Manufacturing' }).status, 'meets');
  assert.equal(cls('la-city', { code: 'MR1-1', category: 'Manufacturing' }).status, 'confirm');
  assert.equal(cls('la-city', { code: '(T)(Q)C2-1L-O', category: 'Commercial' }).status, 'confirm'); // [Q] conditions
  assert.equal(cls('la-city', { code: 'R5-2', category: 'Multiple Family Residential' }).status, 'fails');
  assert.equal(cls('sd-city', { code: 'CC-3-9' }).status, 'meets');
  assert.equal(cls('sd-city', { code: 'CP-1-1' }).class, 'parking');
  assert.equal(cls('sd-city', { code: 'RMX-2' }).status, 'confirm');
  assert.equal(cls('sd-city', { code: 'RS-1-7' }).status, 'fails');
  assert.equal(cls('sd-city', { code: 'CCPD-CORE' }).class, 'planned');
  assert.equal(cls('sj-city', { code: 'CG' }).status, 'meets');
  assert.equal(cls('sj-city', { code: 'CG(PD)' }).class, 'planned');
  assert.equal(cls('sj-city', { code: 'R-1-8' }).status, 'fails');
  assert.equal(cls('oak-city', { code: 'CN-3' }).status, 'meets');
  assert.equal(cls('oak-city', { code: 'RU-5' }).class, 'mixed-residential');
  assert.equal(cls('oak-city', { code: 'RU-2' }).status, 'fails');
  assert.equal(cls('sac-city', { code: 'OB' }).status, 'meets');
  assert.equal(cls('sac-city', { code: 'R-1' }).status, 'fails');
  assert.equal(cls('lb-city', { code: 'CCA (HL-40)' }).status, 'meets');
  assert.equal(cls('lb-city', { code: 'PD-30' }).class, 'planned');
  assert.equal(cls('sf', { code: 'NCT-3' }).status, 'meets');
  assert.equal(cls('sf', { code: 'RH-2' }).status, 'fails');
  assert.equal(cls('la-county', { code: 'MXD' }).status, 'meets');
  assert.equal(cls('sj-city', { code: 'XYZ' }).class, 'unknown');
  assert.equal(cls('glendale', { code: 'R 1650 P' }).class, 'parking'); // Glendale P overlay permits parking lots
  assert.equal(cls('glendale', { code: 'C2 II' }).status, 'meets');
  assert.equal(cls('glendale', { code: 'R1 II' }).status, 'fails');
  assert.equal(cls('hayward', { code: 'CG' }).status, 'meets');
  assert.equal(cls('sunnyvale', { code: 'O' }).status, 'meets');
  assert.equal(cls('elk-grove', { code: 'RD-5' }).status, 'fails');
  assert.equal(cls('oceanside', { code: 'D-6A', category: 'Commercial' }).status, 'meets');
  assert.equal(cls('oceanside', { code: 'PD-27', category: 'Commercial' }).class, 'planned');
  assert.equal(cls('livermore', { code: 'PDC-00-172', category: 'PDC', description: 'Planned Development' }).class, 'planned');
  assert.equal(cls('livermore', { code: 'CNB', category: 'CNB', description: 'Commercial' }).status, 'meets');
  assert.equal(cls('milpitas', { code: 'C2', category: 'Commercial' }).status, 'meets');
  assert.equal(cls('milpitas', { code: 'POS', category: 'Single Family Residential' }).class, 'open-space');
  assert.equal(cls('pleasanton', { code: 'PUD-C-C', description: 'Central Commercial-PUD' }).class, 'planned');
  assert.equal(cls('pleasanton', { code: 'O', description: 'Office Commercial' }).status, 'meets');
  assert.equal(cls('west-covina', { code: 'O-S', description: 'R-1: Residential Single Family' }).class, 'open-space'); // code wins
  assert.equal(cls('west-covina', { code: 'O-P', description: 'OPMU : Office Professional Mixed-Use' }).status, 'confirm');
  assert.equal(cls('cupertino', { code: 'P(CG, R3)', category: 'P', description: 'Planned Development' }).class, 'planned');
  assert.equal(cls('el-cajon', { code: 'P', description: 'Parking' }).class, 'parking');
  assert.equal(cls('palo-alto', { code: 'PC-4296(TOD)', category: 'Commercial/Residential' }).class, 'planned');
  assert.equal(cls('palo-alto', { code: 'CS(TOD)', category: 'Commercial/Residential' }).status, 'meets');
  assert.equal(cls('dublin', { code: 'DDZD' }).class, 'planned');
});

test('what the zoning allows: limits stated in a zone’s name', () => {
  assert.deepEqual(limitsFromText('MF-20 : Residential 20 du/ac'), [{ label: 'Density', value: '20 units per acre' }]);
  assert.deepEqual(limitsFromText('Moderate Density Residential of 6.6-15 Units/Acre'), [{ label: 'Density', value: '6.6–15 units per acre' }]);
  assert.deepEqual(limitsFromText('SFD up to 6 du/ac'), [{ label: 'Density', value: 'up to 6 units per acre' }]);
  assert.deepEqual(limitsFromText('R-1-7500 - Residential Zone (Single Family - 7,500 sq. ft. minimum lot size)'), [{ label: 'Minimum lot size', value: '7,500 sq ft' }]);
  assert.deepEqual(limitsFromText('Multiple-Family Residential (2,400 s.f. min. lot area per unit)'), [{ label: 'Lot area per unit', value: '2,400 sq ft' }]);
  assert.deepEqual(limitsFromText('General Commercial'), []);
  assert.equal(urlFrom("<a href='https://ecode360.com/42705294'>Chapter 23.10</a>"), 'https://ecode360.com/42705294');
});

test('how the zoning was obtained, and how current it is', async () => {
  assert.match(provenance(src('pasadena')).text, /City of Pasadena on its own ArcGIS Online organisation/);
  assert.match(provenance(src('glendale')).text, /own GIS server \(gismap\.glendaleca\.gov\)/);
  assert.match(provenance(src('sacramento-county')).text, /^Published by the County of Sacramento/);
  const tp = zoning.sources.filter((s) => s.thirdParty);
  assert.ok(tp.length >= 5);
  for (const s of tp) {
    assert.ok(s.thirdParty.name, `${s.id}: third-party host must be named`);
    const p = provenance(s);
    assert.equal(p.kind, 'third-party');
    assert.match(p.text, /not by .* Used only because .* does not publish a zoning layer of its own/);
  }
  assert.deepEqual(await layerUpdatedInfo(src('irwindale')), { date: '2019', basis: src('irwindale').asOf.basis });
  assert.ok('2019' < CURRENT_SINCE && '2023-02-01' >= CURRENT_SINCE);
  assert.equal(src('torrance').statusCap, 'confirm');
  assert.ok(src('torrance').caveat);
});

test('split-zoned sites', () => {
  assert.equal(combineZoneStatuses(['meets', 'meets']), 'meets');
  assert.equal(combineZoneStatuses(['meets', 'fails']), 'confirm');
  assert.equal(combineZoneStatuses(['fails', 'fails']), 'fails');
  assert.equal(combineZoneStatuses([]), 'not-evaluated');
});
