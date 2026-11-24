#!/usr/bin/env node
// Measure street right-of-way widths at a parcel from live assessor parcels.
//   node scripts/row-check.mjs "3600 Wilshire Blvd, Los Angeles, CA" ...
import * as turf from '@turf/turf';
import { loadData } from './load-data.mjs';
import { geocode, countyAtPoint } from '../src/lib/lookup.js';
import { parcelsAtPoint, parcelsInBBox } from '../src/lib/parcels.js';
import { measureFrontages, corridorTest } from '../src/lib/row.js';

const { sources } = await loadData();
const FACING = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
for (const q of process.argv.slice(2)) {
  const [g] = await geocode(sources, q);
  if (!g) { console.log(`\n${q}: no geocoder match`); continue; }
  const county = (await countyAtPoint(sources, [g.lon, g.lat])).config;
  const ps = await parcelsAtPoint(county, [g.lon, g.lat]);
  if (!ps.length) { console.log(`\n${g.label}: no parcel`); continue; }
  const parcel = ps.sort((a, b) => turf.area(b) - turf.area(a))[0];
  const [x0, y0, x1, y1] = turf.bbox(parcel);
  const pad = 0.0012; // ~400 ft
  const { features } = await parcelsInBBox(county, [x0 - pad, y0 - pad, x1 + pad, y1 + pad], { maxFeatures: 3000 });
  const fr = measureFrontages(parcel, features);
  console.log(`\n${g.label}  →  APN ${parcel.properties.apn} (${features.length} neighbouring parcels)`);
  for (const f of fr) {
    const t = corridorTest(f);
    console.log(`  faces ${FACING(f.facing).padEnd(2)} frontage ${String(f.lengthFt).padStart(4)} ft  ROW ${f.widthFt ? `${f.widthFt.min}–${f.widthFt.max} ft (median ${f.widthFt.median}, ${f.widthFt.measured} samples, ${f.widthFt.unmeasured} unmeasured)` : 'not measurable'}  ${t.qualifies ? 'CORRIDOR 70–150' : ''}`);
  }
}
