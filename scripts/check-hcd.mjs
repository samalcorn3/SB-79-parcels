#!/usr/bin/env node
// Watches HCD for SB 79 changes that require a human to update
// data/jurisdictions.json:
//   * HCD's SB 79 page and its letters-dashboard page changed since last review
//   * any HCD letter or ordinance URL in the registry stopped resolving
//   * the registry has not been reviewed in 30+ days
// HCD publishes its letters only through an embedded Power BI dashboard, so a
// new letter cannot be read automatically; a page change or the 30-day
// reminder opens an issue so a maintainer checks the dashboard.
//
//   node scripts/check-hcd.mjs            # report; sets `attention=true` output if action needed
//   node scripts/check-hcd.mjs --update   # after review: record current page fingerprints
import { createHash } from 'node:crypto';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { loadData } from './load-data.mjs';

const WATCH_FILE = new URL('../data/hcd-watch.json', import.meta.url);
const STALE_DAYS = 30;
const { registry } = await loadData();
const watch = JSON.parse(await readFile(WATCH_FILE, 'utf8').catch(() => '{"pages":{}}'));

function mainText(html) {
  const start = html.indexOf('Breadcrumb');
  const end = html.indexOf('Connecting with HCD');
  const body = html.slice(start > -1 ? start : 0, end > -1 ? end : undefined);
  return body
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fingerprint(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'sb79-parcels-monitor' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = mainText(await res.text());
  return {
    hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
    lastUpdated: text.match(/Last updated:\s*([\d/]+)/)?.[1] || null,
  };
}

async function resolves(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'sb79-parcels-monitor', Range: 'bytes=0-1023' } });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

const pages = { sb79Page: registry.hcdSb79Page, lettersPage: registry.hcdDashboard };
const findings = [];
const current = {};
for (const [key, url] of Object.entries(pages)) {
  try {
    current[key] = { url, ...(await fingerprint(url)) };
    const prev = watch.pages?.[key];
    if (!prev) findings.push(`First fingerprint recorded for ${url}`);
    else if (prev.hash !== current[key].hash) {
      findings.push(`**${url} changed** since last review${current[key].lastUpdated ? ` (page says “Last updated: ${current[key].lastUpdated}”)` : ''}. Check for new SB 79 guidance or letters.`);
    }
  } catch (e) {
    findings.push(`Could not fetch ${url}: ${e.message}`);
  }
}

const links = [];
for (const [name, j] of Object.entries(registry.jurisdictions)) {
  for (const inst of j.instruments) {
    if (inst.hcd?.letterUrl) links.push([`${name} — HCD letter`, inst.hcd.letterUrl]);
    if (inst.local?.url) links.push([`${name} — local action`, inst.local.url]);
  }
}
const unique = [...new Map(links.map(([l, u]) => [u, [l, u]])).values()];
const broken = [];
await Promise.all(unique.map(async ([label, url]) => { if (!(await resolves(url))) broken.push(`${label}: ${url}`); }));
if (broken.length) findings.push(`Registry links not resolving:\n${broken.map((b) => `  - ${b}`).join('\n')}`);

const ageDays = Math.floor((Date.now() - Date.parse(registry.lastReviewed)) / 864e5);
if (ageDays >= STALE_DAYS) findings.push(`data/jurisdictions.json was last reviewed ${ageDays} days ago (${registry.lastReviewed}). Re-check HCD's letters dashboard.`);

const secondary = Object.entries(registry.jurisdictions).flatMap(([n, j]) => j.instruments.filter((i) => i.verification === 'secondary').map((i) => `${n} (${i.id})`));

const pageChanged = findings.some((f) => f.includes('changed'));
const report = [
  `## HCD SB 79 watch — ${new Date().toISOString().slice(0, 10)}`,
  '',
  findings.length ? findings.map((f) => `- ${f}`).join('\n') : '- No changes detected.',
  '',
  `Registry entries still resting on secondary sources (confirm against ${registry.hcdDashboard}): ${secondary.join(', ') || 'none'}.`,
  '',
  'To resolve: review HCD’s dashboard (filter Housing Law = SB 79 / Gov. Code 65912.*), update `data/jurisdictions.json` (set `lastReviewed`), then run `npm run check:hcd -- --update` and commit `data/hcd-watch.json`.',
].join('\n');
console.log(report);

if (process.argv.includes('--update')) {
  await writeFile(WATCH_FILE, `${JSON.stringify({ updated: new Date().toISOString(), pages: current }, null, 2)}\n`);
  console.log('\nRecorded current fingerprints in data/hcd-watch.json');
}
const attention = pageChanged || broken.length > 0 || ageDays >= STALE_DAYS;
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `attention=${attention}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (process.env.HCD_REPORT_FILE) await writeFile(process.env.HCD_REPORT_FILE, report);
