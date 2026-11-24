#!/usr/bin/env node
// Classify every distinct zone in a jurisdiction's live zoning layer under its rules,
// to review a new or updated data/zoning/<id>.json before committing it.
//   NODE_USE_ENV_PROXY=1 node scripts/zoning-classify.mjs <id> [<id> ...]
// Prints, per status and class, the zones that fall there (code [category] description).
// Anything under "confirm unknown" has no rule yet; check it against the city's code.
import { readFile } from 'node:fs/promises';
import { classifyZone, layerUpdated } from '../src/lib/zoning.js';
import { getJSON } from '../src/lib/arcgis.js';

const data = new URL('../data/', import.meta.url);
const zoning = JSON.parse(await readFile(new URL('zoning.json', data), 'utf8'));
for (const id of process.argv.slice(2)) {
  const s = JSON.parse(await readFile(new URL(`zoning/${id}.json`, data), 'utf8'));
  const f = s.fields;
  const q = { where: '1=1', returnGeometry: 'false', outFields: Object.values(f).join(','), f: 'json' };
  let r = await getJSON(`${s.url}/query`, { ...q, returnDistinctValues: 'true', orderByFields: f.code }).catch(() => null);
  if (!r?.features) r = await getJSON(`${s.url}/query`, q).catch((e) => ({ error: e.message }));
  if (r.error) { console.log(`## ${id}: ${r.error}`); continue; }
  const by = {};
  const seen = new Set();
  for (const ft of r.features) {
    const z = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, ft.attributes[v]]));
    const key = JSON.stringify(z);
    if (seen.has(key) || (!String(z.code ?? '').trim() && !String(z.category ?? '').trim())) continue;
    seen.add(key);
    const c = classifyZone(zoning, s, z);
    (by[`${c.status} ${c.class}`] ||= []).push(`${z.code}${z.category ? ` [${z.category}]` : ''}${z.description && z.description !== z.code ? ` ${z.description}` : ''}`);
  }
  console.log(`## ${id} — layer updated ${await layerUpdated(s) || 'n/a'} — ${seen.size} distinct zones${r.exceededTransferLimit ? ' (first page only)' : ''}`);
  for (const [k, v] of Object.entries(by).sort()) console.log(`  ${k}: ${v.join('; ')}`);
}
