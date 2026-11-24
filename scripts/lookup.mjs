#!/usr/bin/env node
// Usage: npm run lookup -- "200 N Spring St, Los Angeles, CA"
//        npm run lookup -- --point -118.2427,34.0537
import { loadData } from './load-data.mjs';
import { reportForAddress, reportForPoint, ab2011ForReport } from '../src/lib/lookup.js';

const args = process.argv.slice(2);
const data = await loadData();
let report;
if (args[0] === '--point') {
  const [lon, lat] = args[1].split(',').map(Number);
  report = await reportForPoint(data, [lon, lat]);
} else {
  report = await reportForAddress(data, args.join(' '));
}
if (report.ok) report.ab2011 = await ab2011ForReport(data, report);
delete report.ab2011Context;
if (report.parcel) delete report.parcel.geometry;
delete report.provisions;
console.log(JSON.stringify(report, null, 2));
