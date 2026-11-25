#!/usr/bin/env node
// Rebuilds the jurisdiction index in data/zoning.json from data/zoning/*.json.
// Each file holds one jurisdiction's live zoning layer and rules; the index
// tells the site which file serves which city (or unincorporated county), so
// the browser fetches only the file for the parcel being looked up.
// Run after adding, removing or renaming a file:  npm run zoning:index
// With --check, exits 1 if the index is out of date instead of writing it.
import { readFile, writeFile, readdir } from 'node:fs/promises';

const dataDir = new URL('../data/', import.meta.url);
const dir = new URL('zoning/', dataDir);
const indexUrl = new URL('zoning.json', dataDir);

export async function buildIndex() {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const index = [];
  for (const f of files) {
    const s = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    if (s.id !== f.replace(/\.json$/, '')) throw new Error(`data/zoning/${f}: id "${s.id}" must match the file name`);
    const e = { id: s.id, name: s.name };
    if (s.jurisdictions) e.jurisdictions = s.jurisdictions;
    if (s.unincorporatedOf) e.unincorporatedOf = s.unincorporatedOf;
    index.push(e);
  }
  return index;
}

const doc = JSON.parse(await readFile(indexUrl, 'utf8'));
const index = await buildIndex();
const next = `${JSON.stringify({ ...doc, index }, null, 2)}\n`;
const current = await readFile(indexUrl, 'utf8');
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('data/zoning.json index is out of date; run `npm run zoning:index`.');
    process.exit(1);
  }
  console.log(`Zoning index OK (${index.length} jurisdictions).`);
} else {
  await writeFile(indexUrl, next);
  console.log(`Wrote index of ${index.length} jurisdictions to data/zoning.json.`);
}
