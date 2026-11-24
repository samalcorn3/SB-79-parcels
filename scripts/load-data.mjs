// Loads the data documents from disk (Node scripts and tests).
import { readFile } from 'node:fs/promises';

const root = new URL('../data/', import.meta.url);
const read = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

export async function loadData() {
  const [sources, standards, registry, zoning] = await Promise.all([read('sources.json'), read('standards.json'), read('jurisdictions.json'), read('zoning.json')]);
  return { sources, standards, registry, zoning };
}
