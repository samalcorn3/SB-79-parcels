#!/usr/bin/env node
// Coverage of local zoning across the counties the site covers: which cities (and unincorporated
// counties) have a zoning layer configured, how current it is, and who hosts it.
//   NODE_USE_ENV_PROXY=1 node scripts/zoning-coverage.mjs [out.md]
// Reads each layer's update date live, so it takes a minute.
import { writeFile } from 'node:fs/promises';
import { loadData, loadZoningSources } from './load-data.mjs';
import { layerUpdatedInfo, CURRENT_SINCE } from '../src/lib/zoning.js';
import { getJSON } from '../src/lib/arcgis.js';

const { sources } = await loadData();
const zs = await loadZoningSources();
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const b = sources.boundaries.cities;
const rows = await getJSON(`${b.url}/query`, { where: '1=1', outFields: `${b.fields.name},${b.fields.county}`, returnDistinctValues: 'true', returnGeometry: 'false', f: 'json', resultRecordCount: 2000 });
const byCounty = new Map();
for (const r of rows.features.map((f) => f.attributes)) {
  const county = sources.counties.find((c) => fold(`${c.name}`).startsWith(fold(r[b.fields.county]).replace(/ county$/, '')));
  if (!county || !r[b.fields.name] || /unincorporated/i.test(r[b.fields.name])) continue;
  if (!byCounty.has(county.id)) byCounty.set(county.id, { county, cities: new Set() });
  byCounty.get(county.id).cities.add(r[b.fields.name]);
}
const status = async (s) => {
  const u = await layerUpdatedInfo(s);
  const tags = [];
  if (s.thirdParty) tags.push('third-party host');
  if (s.statusCap) tags.push('known gaps');
  else if (s.caveat) tags.push('see caveat');
  if (u?.date && u.date < CURRENT_SINCE) tags.push(`older layer, ${u.date.slice(0, 4)}`);
  if (!u?.date) tags.push('no update date');
  return { updated: u?.date || '—', tags };
};
const out = ['| County | City or area | Layer last updated | Notes |', '|---|---|---|---|'];
const summary = [];
for (const { county, cities } of [...byCounty.values()].sort((a, c) => a.county.name.localeCompare(c.county.name))) {
  let n = 0;
  for (const city of [...cities].sort()) {
    const s = zs.find((x) => (x.jurisdictions || []).some((j) => fold(j) === fold(city)));
    if (!s) { out.push(`| ${county.name} | ${city} | — | **not covered** |`); continue; }
    n++;
    const st = await status(s);
    out.push(`| ${county.name} | ${city} | ${st.updated} | ${st.tags.join('; ') || 'current, city-published'} |`);
  }
  const unc = zs.find((x) => x.unincorporatedOf === county.id);
  if (unc) { const st = await status(unc); out.push(`| ${county.name} | Unincorporated | ${st.updated} | ${st.tags.join('; ') || 'current, county-published'} |`); }
  else if (county.id !== 'san-francisco') out.push(`| ${county.name} | Unincorporated | — | **not covered** |`);
  summary.push(`| ${county.name} | ${n} of ${cities.size} | ${unc ? 'yes' : county.id === 'san-francisco' ? 'n/a' : 'no'} |`);
}
const md = ['| County | Cities covered | Unincorporated area |', '|---|---|---|', ...summary, '', ...out].join('\n');
console.log(md);
if (process.argv[2]) await writeFile(process.argv[2], `${md}\n`);
