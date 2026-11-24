#!/usr/bin/env node
// Verifies every live endpoint in data/sources.json and data/jurisdictions.json:
// the layer responds, every field the code reads still exists, and a query
// returns rows. Prints a Markdown report (also written to $GITHUB_STEP_SUMMARY
// when run in Actions). Exits 1 if any source is broken.
import { appendFile, writeFile } from 'node:fs/promises';
import { loadData, loadZoningSources } from './load-data.mjs';
import { getJSON } from '../src/lib/arcgis.js';
import { latestFarmlandLayer } from '../src/lib/exclusions.js';

const { sources, registry } = await loadData();
const rows = [];

function specFields(spec) {
  if (!spec) return [];
  if (Array.isArray(spec)) return spec;
  if (typeof spec === 'string') return [spec];
  return spec.field ? [spec.field] : [];
}

async function checkArcgis(name, url, fields = [], where = '1=1') {
  const t0 = Date.now();
  try {
    const info = await getJSON(url, { f: 'json' }, { retries: 3 });
    const have = new Set((info.fields || []).map((f) => f.name.toLowerCase()));
    const missing = fields.filter((f) => f && !have.has(f.toLowerCase()));
    const count = await getJSON(`${url}/query`, { where, returnCountOnly: true, f: 'json' }, { retries: 3 });
    const edited = info.editingInfo?.lastEditDate || info.editingInfo?.dataLastEditDate;
    rows.push({
      name, url, ok: missing.length === 0 && count.count > 0,
      detail: missing.length ? `missing fields: ${missing.join(', ')}` : `${count.count.toLocaleString()} features`,
      edited: edited ? new Date(edited).toISOString().slice(0, 10) : '—',
      ms: Date.now() - t0,
    });
  } catch (e) {
    rows.push({ name, url, ok: false, detail: e.message, edited: '—', ms: Date.now() - t0 });
  }
}

async function checkSocrata(name, cfg, fields = []) {
  const t0 = Date.now();
  try {
    const sample = await getJSON(cfg.url, { $limit: 1, $where: cfg.where });
    const have = new Set(Object.keys(sample[0] || {}).map((k) => k.toLowerCase()));
    const missing = [...fields, cfg.geometryField].filter((f) => f && !have.has(f.toLowerCase()));
    const meta = await getJSON(cfg.url.replace('/resource/', '/api/views/').replace(/\.json$/, '.json')).catch(() => null);
    rows.push({
      name, url: cfg.url, ok: sample.length > 0 && missing.length === 0,
      detail: missing.length ? `missing fields: ${missing.join(', ')}` : 'responding',
      edited: meta?.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : '—',
      ms: Date.now() - t0,
    });
  } catch (e) {
    rows.push({ name, url: cfg.url, ok: false, detail: e.message, edited: '—', ms: Date.now() - t0 });
  }
}

const tasks = [];
for (const [k, b] of Object.entries(sources.boundaries)) tasks.push(checkArcgis(`CDT ${k}`, b.url, Object.values(b.fields)));
tasks.push(checkArcgis('Caltrans functional class', sources.caltrans.functionalClass.url, sources.caltrans.functionalClass.fields));
tasks.push(checkArcgis('Census 2020 urban areas', sources.census.urbanAreas.url, sources.census.urbanAreas.fields));
for (const k of ['vhfhsz', 'sra']) tasks.push(checkArcgis(`State Fire Marshal ${k}`, sources.fireHazard[k].url, sources.fireHazard[k].fields, sources.fireHazard[k].where));
{
  // § 65913.4(a)(6) site exclusions
  const x = sources.siteExclusions;
  for (const [k, l] of Object.entries(x)) {
    if (l?.url) tasks.push(checkArcgis(`Site exclusions: ${k}`, l.url, l.fields));
  }
  x.hazardous.layers.forEach((l) => tasks.push(checkArcgis(`Site exclusions: DTSC ${l.label}`, l.url, l.fields)));
  tasks.push(latestFarmlandLayer(x.farmland)
    .then((f) => checkArcgis(`Site exclusions: farmland (${f.year} survey)`, f.url, x.farmland.fields, x.farmland.where))
    .catch((e) => rows.push({ name: 'Site exclusions: farmland', url: x.farmland.folder, ok: false, detail: e.message, edited: '—', ms: 0 })));
}
for (const z of await loadZoningSources()) {
  if (z.url) tasks.push(checkArcgis(`Zoning: ${z.name}`, z.url, Object.values(z.fields)));
}
for (const m of sources.mpos) {
  m.zoneLayers.forEach((l, i) => tasks.push(checkArcgis(`${m.id} zones[${i}]`, l.url, [...(l.outFields || []), ...specFields(l.tier), ...specFields(l.band)])));
  tasks.push(checkArcgis(`${m.id} stops`, m.stops.url, [...specFields(m.stops.name), ...specFields(m.stops.tier)]));
  if (m.accessPoints) tasks.push(checkArcgis(`${m.id} access points`, m.accessPoints.url, specFields(m.accessPoints.tier)));
}
for (const c of sources.counties) {
  for (const [label, src] of [['parcels', c.parcels], ['parcels (fallback)', c.parcels.fallback]]) {
    if (!src) continue;
    const fields = Object.values(src.fields).flat();
    tasks.push(src.type === 'socrata' ? checkSocrata(`${c.id} ${label}`, src, fields) : checkArcgis(`${c.id} ${label}`, src.url, fields, src.where));
  }

}
for (const [name, j] of Object.entries(registry.jurisdictions)) {
  for (const inst of j.instruments) {
    if (inst.coverage?.type !== 'arcgis') continue;
    const fields = [inst.coverage.reasonField, ...Object.keys(inst.coverage.reasonFields || {})].filter(Boolean);
    tasks.push(checkArcgis(`${name}: ${inst.id} coverage`, inst.coverage.url, fields, inst.coverage.where));
  }
}
await Promise.all(tasks);

rows.sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));
const md = [
  `## Live source check — ${new Date().toISOString()}`,
  '',
  '| | Source | Result | Last edited | ms |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} | [${r.name}](${r.url}) | ${r.detail.replace(/\|/g, '\\|')} | ${r.edited} | ${r.ms} |`),
].join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
if (process.argv[2]) await writeFile(process.argv[2], md);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
