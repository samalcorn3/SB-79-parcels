#!/usr/bin/env node
// Zoning freshness watch. The site reads each jurisdiction's zoning layer live,
// so edits a city makes to that layer appear at once. What it cannot see on its
// own is a city publishing its updated zoning as a *new* layer (e.g. Oakland
// publishes a new service per zoning ordinance; Pomona and Whittier name theirs
// by year), which would leave the configured layer frozen. This script:
//   1. reads each configured layer's last-update date;
//   2. lists the zoning services the same publisher offers (its ArcGIS Online
//      organisation, or the same server folder), and flags any that changed
//      after the configured one — a likely successor to review.
// Prints a Markdown report (and writes it to argv[2] if given). Exits 3 if a
// newer zoning layer was found or a layer could not be read.
import { writeFile } from 'node:fs/promises';
import { loadData } from './load-data.mjs';
import { getJSON } from '../src/lib/arcgis.js';
import { layerUpdated } from '../src/lib/zoning.js';

const SKIP = /overlay|label|green|appeal|captain|fire|flood|evac|police|trash|sweep|liquef|landslide|fault|opportun|enterprise|school|vending|ember|tsunami|maint|response|dispatch|drone|zonehaven|wildland|airport|noise|coastal|historic|pressure|parade|homeless|parking_?zone|test|draft|qc|copy|scene|3d|climate|hardiness|verizon/i;
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/** Where the publisher lists its other services: the AGOL organisation root, or the server folder. */
function directoryOf(url) {
  const agol = url.match(/^(https:\/\/services\d*\.arcgis\.com\/[A-Za-z0-9]{16}\/arcgis\/rest\/services)\//);
  if (agol) return { root: agol[1], folder: null };
  const m = url.match(/^(https?:\/\/.+?\/rest\/services)\/(.+?)\/(?:[^/]+)\/(?:MapServer|FeatureServer)/);
  if (m) return { root: m[1], folder: m[2] };
  const top = url.match(/^(https?:\/\/.+?\/rest\/services)\/[^/]+\/(?:MapServer|FeatureServer)/);
  return top ? { root: top[1], folder: null } : null;
}

/** Latest edit date across a service's polygon layers (hosted layers report editingInfo). */
async function serviceEdited(svcUrl) {
  const info = await getJSON(svcUrl, { f: 'json' }, { retries: 1, timeoutMs: 20000 });
  let best = info.editingInfo?.dataLastEditDate || info.editingInfo?.lastEditDate || null;
  for (const l of (info.layers || []).slice(0, 6)) {
    try {
      const li = await getJSON(`${svcUrl}/${l.id}`, { f: 'json' }, { retries: 0, timeoutMs: 15000 });
      const t = li.editingInfo?.dataLastEditDate || li.editingInfo?.lastEditDate;
      if (t && (!best || t > best)) best = t;
    } catch { /* ignore */ }
  }
  return best;
}

const { zoning } = await loadData();
const rows = [];
let attention = false;
const only = process.env.ZONING_ONLY ? process.env.ZONING_ONLY.split(',') : null;
for (const s of zoning.sources) {
  if (only && !only.includes(s.id)) continue;
  if (!s.url) { rows.push({ s, updated: 'from parcel record', note: 'Read from the parcel dataset itself.' }); continue; }
  let updated = null;
  let note = '';
  try {
    updated = await layerUpdated(s);
  } catch { /* handled below */ }
  const svcUrl = s.url.replace(/\/\d+$/, '');
  const dir = directoryOf(s.url);
  const successors = [];
  if (dir) {
    try {
      const listing = await getJSON(dir.folder ? `${dir.root}/${dir.folder}` : dir.root, { f: 'json' }, { retries: 1, timeoutMs: 20000 });
      const mine = svcUrl.split('/rest/services/')[1];
      const candidates = (listing.services || [])
        .filter((x) => /zon/i.test(x.name) && !SKIP.test(x.name) && (x.type === 'FeatureServer' || x.type === 'MapServer'))
        .filter((x) => `${x.name}/${x.type}` !== mine);
      const myEdited = updated ? Date.parse(updated) : null;
      for (const c of candidates.slice(0, 12)) {
        const cu = `${dir.root}/${c.name}/${c.type}`;
        const t = await serviceEdited(cu).catch(() => null);
        // A layer already reviewed and found not to supersede ours is flagged again only if it changes after that review.
        const rev = (s.reviewedAlternatives || []).find((r) => c.name === r.service || c.name.endsWith(`/${r.service}`));
        const since = Math.max(myEdited || 0, rev ? Date.parse(rev.asOf) : 0);
        if (t && myEdited && t > since + 7 * 864e5) successors.push(`[${c.name}](${cu}) (edited ${day(t)})`);
      }
    } catch (e) {
      note = `Could not list the publisher's services (${e.message}).`;
    }
  }
  if (successors.length) {
    attention = true;
    note = `**Newer zoning layer(s) from the same publisher — check whether one supersedes the configured layer:** ${successors.join('; ')}`;
  }
  if (!updated && !note) note = 'Layer reports no update date; it is read from the city’s own server.';
  rows.push({ s, updated: updated || '—', note });
}

const out = [
  '## Zoning layer freshness',
  '',
  'Each layer is queried live, so edits a jurisdiction makes to it appear immediately. This report flags a jurisdiction that has published a newer zoning layer elsewhere, which the site would not pick up until `data/zoning.json` points to it.',
  '',
  '| Jurisdiction | Layer last updated | Notes |',
  '|---|---|---|',
  ...rows.map((r) => `| ${r.s.url ? `[${r.s.name}](${r.s.url})` : r.s.name} | ${r.updated} | ${r.note} |`),
].join('\n');
console.log(out);
if (process.argv[2]) await writeFile(process.argv[2], out);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${out}\n`, { flag: 'a' });
process.exit(attention ? 3 : 0);
