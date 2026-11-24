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
  assert.deepEqual([st.vhfhsz.hit, st.sra.hit, st.within, st.partial], [true, false, false, true]); // half in: partial, not "within"
  const whole = turf.polygon([[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]);
  assert.equal(fireStatus(parcel, { vhfhsz: [whole], sra: [] }).within, true);
  assert.equal(fireStatus(parcel, { vhfhsz: [], sra: [whole] }).within, true); // SRA alone qualifies
  // a lot line that merely touches a fire-zone boundary is not "within" it
  const touching = turf.polygon([[[0.001, 0], [1, 0], [1, 1], [0.001, 1], [0.001, 0]]]);
  assert.equal(fireStatus(parcel, { vhfhsz: [touching], sra: [] }).qualifies, false);
});

test('fire-zone ordinances: excluded in a fire zone, unconfirmed elsewhere', () => {
  const gle = findJurisdiction(registry, 'San Diego'); // O-22099 § 4: very high FHSZ only
  const inst = gle.instruments[0];
  const fireYes = { vhfhsz: { hit: true, share: 1, within: true }, sra: { hit: false, share: 0, within: false }, within: true, partial: false, qualifies: true };
  const fireNo = { vhfhsz: { hit: false, share: 0, within: false }, sra: { hit: false, share: 0, within: false }, within: false, partial: false, qualifies: false };
  const firePart = { vhfhsz: { hit: true, share: 0.4, within: false }, sra: { hit: false, share: 0, within: false }, within: false, partial: true, qualifies: false };
  const sraOnly = { vhfhsz: { hit: false, share: 0, within: false }, sra: { hit: true, share: 1, within: true }, within: true, partial: false, qualifies: true };
  const la = sources.counties.find((c) => c.id === 'san-diego');
  const zones = [{ tier: 2, band: 'quarter', flags: [] }];
  const yes = determineRegime({ zones, county: la, jurisdiction: gle, cityName: 'San Diego', coverage: { [inst.id]: criteriaCoverage(inst, fireYes) } });
  assert.equal(yes.regime, 'excluded');
  assert.match(yes.detail, /Very High Fire Hazard/);
  // O-22099 also covers historic, low-resource, etc. sites, which aren't mapped publicly → not "no", but "unconfirmed"
  const no = determineRegime({ zones, county: la, jurisdiction: gle, cityName: 'San Diego', coverage: { [inst.id]: criteriaCoverage(inst, fireNo) } });
  assert.equal(no.regime, 'statute-unless-excluded');
  // Partly in a fire zone: the statute is silent, so the exclusion is not applied, only flagged.
  const cov = criteriaCoverage(inst, firePart);
  assert.equal(cov.covered, null);
  assert.match(cov.reason, /only partly/);
  // O-22099 § 4 names very high FHSZ only, so a parcel only in the SRA is not covered by it.
  assert.equal(criteriaCoverage(inst, sraOnly).covered, null);
  assert.notEqual(criteriaCoverage(inst, sraOnly).covered, true);
});

test('fire hazard sources point at the State Fire Marshal layers', () => {
  assert.match(sources.fireHazard.publisher, /State Fire Marshal/);
  assert.equal(sources.fireHazard.vhfhsz.where, 'FHSZ = 3');
  assert.match(sources.fireHazard.statute, /65912\.161\(b\)\(1\)\(D\)/);
});
