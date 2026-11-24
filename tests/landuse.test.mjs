// Assessor land-use classification and AB 2011's neighbouring-use tests, on synthetic parcels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { landUseOf, adjoiningParcels, useTests } from '../src/lib/landuse.js';
import { urbanUsesCriterion, industrialCriterion, housingCriterion } from '../src/lib/ab2011.js';

const sources = JSON.parse(await readFile(new URL('../data/sources.json', import.meta.url), 'utf8'));
const la = sources.counties.find((c) => c.id === 'los-angeles').parcels.landUse;
const sac = sources.counties.find((c) => c.id === 'sacramento').parcels.landUse;

// Local planar helper: build a lon/lat rectangle from feet offsets around (lon0, lat0).
const lon0 = -118.3, lat0 = 34.06;
const kx = 111320 * Math.cos((lat0 * Math.PI) / 180) * 3.28084, ky = 110574 * 3.28084;
const rect = (x0, y0, x1, y1, raw = {}) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => [lon0 + x / kx, lat0 + y / ky])] },
  properties: { raw, address: raw.addr || null },
});

test('LA assessor uses', () => {
  assert.equal(landUseOf(la, { UseDescription: 'Office Buildings', Roll_ImpValue: 1e6 }).class, 'commercial');
  assert.equal(landUseOf(la, { UseDescription: 'Warehousing, Distribution, Storage', Roll_ImpValue: 1e6 }).class, 'industrial');
  assert.equal(landUseOf(la, { UseDescription: 'Five or more apartments', Units1: 3, Units2: 1, Roll_ImpValue: 1 }).class, 'residential-small'); // unit count wins
  assert.equal(landUseOf(la, { UseDescription: 'Single', Units1: 1, Roll_ImpValue: 1 }).class, 'residential-small');
  assert.equal(landUseOf(la, { UseDescription: 'Stores', Roll_ImpValue: 0 }).class, 'vacant');
  assert.equal(landUseOf(la, { UseDescription: 'Parking Lots (Commercial Use Properties)', Roll_ImpValue: 5 }).class, 'parking');
  assert.equal(landUseOf(la, { UseDescription: 'Mobile Home Parks', Roll_ImpValue: 5 }).class, 'mobilehome-park');
  assert.equal(landUseOf(la, { UseDescription: 'Something new', Roll_ImpValue: 5 }).class, 'unknown');
});

test('Sacramento assessor uses', () => {
  assert.equal(landUseOf(sac, { LU_GENERAL: 'Residential', LU_SPECIF: 'Motel' }).class, 'commercial');
  assert.equal(landUseOf(sac, { LU_GENERAL: 'Residential', LU_SPECIF: 'Two Family' }).class, 'residential-small');
  assert.equal(landUseOf(sac, { LU_GENERAL: 'Residential', LU_SPECIF: 'Low Rise Apartment' }).class, 'residential');
  assert.equal(landUseOf(sac, { LU_GENERAL: 'Industrial', LU_SPECIF: 'Warehouse' }).class, 'industrial');
  assert.equal(landUseOf(sac, { LU_GENERAL: 'Vacant', LU_SPECIF: '' }).class, 'vacant');
});

// Subject 100 × 100 ft. West: touching neighbour (100 ft). North: touching neighbour.
// East: across a 60-ft street. South: across an 80-ft street, an industrial parcel.
const subject = rect(0, 0, 100, 100, { UseDescription: 'Stores', Roll_ImpValue: 9 });
const west = rect(-100, 0, 0, 100, { UseDescription: 'Five or more apartments', Units1: 12, Roll_ImpValue: 9, addr: 'W' });
const north = rect(0, 100, 100, 200, { UseDescription: 'Office Buildings', Roll_ImpValue: 9, addr: 'N' });
const east = rect(160, -50, 260, 150, { UseDescription: 'Stores', Roll_ImpValue: 9, addr: 'E' });
const south = rect(-50, -180, 150, -80, { UseDescription: 'Heavy Manufacturing', Roll_ImpValue: 9, addr: 'S' });

test('perimeter walk finds touching and across-the-street neighbours', () => {
  const r = adjoiningParcels(subject, [subject, west, north, east, south]);
  assert.ok(Math.abs(r.perimeterFt - 400) < 1);
  const by = Object.fromEntries(r.adjoining.map((a) => [a.neighbor.properties.address, a]));
  for (const k of ['W', 'N', 'E', 'S']) assert.ok(Math.abs(by[k].lengthFt - 100) < 6, `${k} ${by[k]?.lengthFt}`);
  assert.equal(by.W.acrossStreet, false);
  assert.equal(by.E.acrossStreet, true);
  assert.equal(by.S.acrossStreet, true);
});

test('75% urban test and industrial neighbour', () => {
  const u = useTests(la, subject, [west, north, east, south]);
  assert.ok(Math.abs(u.share.urban - 0.75) < 0.02, String(u.share.urban));
  assert.equal(u.industrialNeighbors.length, 1);
  assert.equal(u.industrialNeighbors[0].address, 'S');
  assert.equal(industrialCriterion(u, null).status, 'confirm');
  // Replace the factory with shops: no industrial use found, which is not conclusive (general plan test).
  const shops = rect(-50, -180, 150, -80, { UseDescription: 'Stores', Roll_ImpValue: 9, addr: 'S2' });
  const u2 = useTests(la, subject, [west, north, east, shops]);
  assert.equal(urbanUsesCriterion(u2).status, 'meets');
  assert.equal(industrialCriterion(u2, null).status, 'none-mapped');
  // Two industrial sides: at most 50% urban, fails.
  const factoryN = rect(0, 100, 100, 200, { UseDescription: 'Industrial', Roll_ImpValue: 9 });
  assert.equal(urbanUsesCriterion(useTests(la, subject, [west, factoryN, east, south])).status, 'fails');
});

test('existing housing on a mixed-income site', () => {
  const at = (raw) => useTests(la, rect(0, 0, 100, 100, raw), [west]);
  assert.equal(housingCriterion(at({ UseDescription: 'Two Units', Units1: 2, Roll_ImpValue: 9 }), null).status, 'fails'); // (h)(4)
  assert.equal(housingCriterion(at({ UseDescription: 'Five or more apartments', Units1: 20, Roll_ImpValue: 9 }), null).status, 'confirm');
  assert.equal(housingCriterion(at({ UseDescription: 'Office Buildings', Roll_ImpValue: 9 }), null).status, 'none-mapped');
  assert.equal(housingCriterion(at({ UseDescription: 'Stores', Roll_ImpValue: 0 }), null).status, 'confirm'); // vacant: (h)(5) depends on zoning
  assert.equal(housingCriterion(null, null).status, 'confirm');
});
