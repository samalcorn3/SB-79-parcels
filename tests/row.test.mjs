import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureFrontages, corridorTest, projector } from '../src/lib/row.js';

// Build parcels in feet around a reference point, then convert to lon/lat.
const P = projector([-118.3, 34.06]);
const rect = (x, y, w, h) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(P.inv)] } });

test('measures an 80-ft street between facing parcels, and ignores side lot lines', () => {
  const subject = rect(0, 0, 100, 150);           // fronts a street to the north (y = 150)
  const across = rect(-200, 230, 500, 150);        // far side of the street: 230 - 150 = 80 ft
  const left = rect(-100, 0, 100, 150);            // shares the west lot line
  const right = rect(100, 0, 100, 150);            // shares the east lot line
  const behind = rect(-200, -150, 500, 150);       // shares the south lot line
  const fr = measureFrontages(subject, [subject, across, left, right, behind]);
  assert.equal(fr.length, 1, 'only the street side is a frontage');
  assert.equal(fr[0].lengthFt, 100);
  assert.ok(Math.abs(fr[0].widthFt.median - 80) < 0.5, `got ${fr[0].widthFt.median}`);
  const t = corridorTest(fr[0]);
  assert.deepEqual([t.rowInRange, t.frontageOk, t.qualifies, t.wide], [true, true, true, false]);
});

test('corner lot gets one frontage per street, each measured separately', () => {
  const subject = rect(0, 0, 100, 100);
  const north = rect(-300, 160, 600, 100);         // 60-ft street to the north
  const east = rect(210, -300, 100, 400);          // 110-ft street to the east
  const west = rect(-100, 0, 100, 100);
  const south = rect(-300, -100, 500, 100);
  const fr = measureFrontages(subject, [subject, north, east, west, south]);
  const byFacing = Object.fromEntries(fr.map((f) => [f.facing, f]));
  assert.ok(Math.abs(byFacing[0].widthFt.median - 60) < 0.5);
  assert.ok(Math.abs(byFacing[90].widthFt.median - 110) < 0.5);
  assert.equal(corridorTest(byFacing[0]).qualifies, false); // 60 ft < 70
  assert.equal(corridorTest(byFacing[90]).wide, true);      // ≥ 100 ft (§ 65912.123)
});

test('nothing across the street within range is reported as unmeasured, not as a width', () => {
  const subject = rect(0, 0, 100, 100);
  const fr = measureFrontages(subject, [subject, rect(-100, 0, 100, 100), rect(100, 0, 100, 100), rect(-200, -100, 500, 100)]);
  assert.equal(fr.length, 1);
  assert.equal(fr[0].widthFt, null);
  assert.equal(corridorTest(fr[0]).qualifies, false);
});
