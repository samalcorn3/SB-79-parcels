// Loads the data documents from disk (Node scripts and tests).
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../data/', import.meta.url);
const read = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

export async function loadData() {
  const [sources, standards, registry, zoning] = await Promise.all([read('sources.json'), read('standards.json'), read('jurisdictions.json'), read('zoning.json')]);
  zoning.loadSource = (id) => read(`zoning/${id}.json`);
  return { sources, standards, registry, zoning };
}

/** Every jurisdiction's zoning file (data/zoning/*.json), for checks and tests. */
export async function loadZoningSources() {
  const files = (await readdir(new URL('zoning/', root))).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map((f) => read(`zoning/${f}`)));
}
