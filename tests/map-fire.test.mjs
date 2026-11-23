import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { loadData } from '../scripts/load-data.mjs';
import { classifyParcels } from '../src/ui/maplayers.js';
import { fireStatus, overlapShare } from '../src/lib/fire.js';
import { criteriaCoverage } from '../src/lib/lookup.js';
import { determineRegime, findJurisdiction } from '../src/lib/policy.js';

const { sources, registry } = await loadData();
const sq = (x, y, d = 0.001) => turf.polygon([[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]]);

test('regression: parcels inside one part of a dissolved multipolygon zone are classified', () => {
  // SCAG publishes each zone class as one multipolygon with hundreds of parts;
  // parts far from the view used to break clipping and every parcel read "not in a zone".
  const zone = turf.multiPolygon([sq(0, 0, 0.01).geometry.coordinates, sq(5, 5, 0.01).geometry.coordinates]);
  const parts = [];
  turf.flattenEach(zone, (p) => parts.push({ ...p, properties: { _z: { tier: 2, band: 'quarter', flags: [] }, _code: 'T2-quarter' }, bbox: turf.bbox(p) }));
  const parcels = [sq(0.002, 0.002, 0.0005), sq(1, 1, 0.0005)];
  const { errors } = classifyParcels(parcels, parts);
  assert.equal(errors, 0);
  assert.equal(parcels[0].properties._code, 'T2-quarter');
  assert.equal(parcels[1].properties._code, 'none');
});

test('parcel touching a zone edge counts (nearest-edge measurement)', () => {
  const z = { ...sq(0, 0, 0.01), properties: { _z: { tier: 1, band: 'half', flags: [] } } };
  const p = sq(0.01, 0.005, 0.001); // shares the zone's east edge
  classifyParcels([p], [z]);
  assert.equal(p.properties._code, 'T1-half');
});

test('fire overlap share and statutory criterion', () => {
  const parcel = sq(0, 0, 0.001);
  const half = turf.polygon([[[0.0005, -1], [1, -1], [1, 1], [0.0005, 1], [0.0005, -1]]]);
  assert.ok(Math.abs(overlapShare(parcel, [half]) - 0.5) < 0.01);
  assert.equal(overlapShare(parcel, [sq(5, 5)]), 0);
  const st = fireStatus(parcel, { vhfhsz: [half], sra: [] });
  assert.deepEqual([st.vhfhsz.hit, st.sra.hit, st.qualifies], [true, false, true]);
  assert.equal(fireStatus(parcel, { vhfhsz: [], sra: [half] }).qualifies, true); // SRA alone qualifies
  // a lot line that merely touches a fire-zone boundary is not "within" it
  const touching = turf.polygon([[[0.001, 0], [1, 0], [1, 1], [0.001, 1], [0.001, 0]]]);
  assert.equal(fireStatus(parcel, { vhfhsz: [touching], sra: [] }).qualifies, false);
});

test('fire-zone ordinances: excluded in a fire zone, unconfirmed elsewhere', () => {
  const gle = findJurisdiction(registry, 'Glendale');
  const inst = gle.instruments[0];
  const fireYes = { vhfhsz: { hit: true, share: 1 }, sra: { hit: false, share: 0 }, qualifies: true };
  const fireNo = { vhfhsz: { hit: false, share: 0 }, sra: { hit: false, share: 0 }, qualifies: false };
  const la = sources.counties.find((c) => c.id === 'los-angeles');
  const zones = [{ tier: 2, band: 'quarter', flags: [] }];
  const yes = determineRegime({ zones, county: la, jurisdiction: gle, cityName: 'Glendale', coverage: { [inst.id]: criteriaCoverage(inst, fireYes) } });
  assert.equal(yes.regime, 'excluded');
  assert.match(yes.detail, /Very High Fire Hazard/);
  // Glendale's ordinance also covers historic sites, which aren't mapped publicly → not "no", but "unconfirmed"
  const no = determineRegime({ zones, county: la, jurisdiction: gle, cityName: 'Glendale', coverage: { [inst.id]: criteriaCoverage(inst, fireNo) } });
  assert.equal(no.regime, 'statute-unless-excluded');
});

test('fire hazard sources point at the State Fire Marshal layers', () => {
  assert.match(sources.fireHazard.publisher, /State Fire Marshal/);
  assert.equal(sources.fireHazard.vhfhsz.where, 'FHSZ = 3');
  assert.match(sources.fireHazard.statute, /65912\.161\(b\)\(1\)\(D\)/);
});
