// Zoning rules for AB 2011's "zone where office, retail, or parking are a principally permitted use".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickZoningSource, classifyZone, combineZoneStatuses } from '../src/lib/zoning.js';

const zoning = JSON.parse(await readFile(new URL('../data/zoning.json', import.meta.url), 'utf8'));
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

test('source choice: the city’s own layer, or the county’s for unincorporated land; nothing else', () => {
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: 'Los Angeles' }).id, 'la-city');
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: null }).id, 'la-county');
  assert.equal(pickZoningSource(zoning, { countyId: 'los-angeles', cityName: 'Pasadena' }), null); // no regional compilations
  assert.equal(pickZoningSource(zoning, { countyId: 'santa-clara', cityName: 'San José' }).id, 'sj-city');
  assert.equal(pickZoningSource(zoning, { countyId: 'alameda', cityName: 'Pleasanton' }), null);
  assert.equal(pickZoningSource(zoning, { countyId: 'san-diego', cityName: null }).id, 'sd-county');
  assert.equal(pickZoningSource(zoning, { countyId: 'san-diego', cityName: 'Carlsbad' }), null);
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
});

test('split-zoned sites', () => {
  assert.equal(combineZoneStatuses(['meets', 'meets']), 'meets');
  assert.equal(combineZoneStatuses(['meets', 'fails']), 'confirm');
  assert.equal(combineZoneStatuses(['fails', 'fails']), 'fails');
  assert.equal(combineZoneStatuses([]), 'not-evaluated');
});
