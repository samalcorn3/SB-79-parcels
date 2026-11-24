#!/usr/bin/env node
// Headless-browser smoke test of the live site against the real data sources.
// Leaflet and Turf are served from node_modules (so the test does not depend on
// the CDN); every GIS request goes to the authoritative servers.
//   node scripts/browser-smoke.mjs [outDir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('..', import.meta.url).pathname;
const outDir = process.argv[2] || '.';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = path === '/' ? 'index.html' : path;
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const turfNames = Object.keys(require('@turf/turf')).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
const turfUmd = await readFile(join(root, 'node_modules/@turf/turf/turf.min.js'), 'utf8');
const turfEsm = `${turfUmd}\nconst __t = globalThis.turf;\nexport const { ${turfNames.join(', ')} } = __t;\nexport default __t;`;
const leafletDir = join(root, 'node_modules/leaflet/dist');

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
const browser = await chromium.launch({ proxy });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('requestfailed', (r) => consoleErrors.push('FAILED ' + r.url().slice(0, 120) + ' ' + r.failure()?.errorText));
await page.route('https://cdn.jsdelivr.net/**', async (route) => {
  const u = route.request().url();
  if (u.includes('@turf/turf')) return route.fulfill({ contentType: 'text/javascript', body: turfEsm });
  if (u.endsWith('leaflet.js')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(join(leafletDir, 'leaflet.js')) });
  if (u.endsWith('leaflet.css')) return route.fulfill({ contentType: 'text/css', body: await readFile(join(leafletDir, 'leaflet.css')) });
  return route.fulfill({ status: 404 });
});
const tileStats = { ok: 0, bad: [] };
page.on('response', (r) => {
  if (!r.url().includes('/MapServer/tile/')) return;
  if (r.status() === 200 && /image/.test(r.headers()['content-type'] || '')) tileStats.ok++;
  else tileStats.bad.push(`${r.status()} ${r.url()}`);
});

const results = [];
async function check(name, url, waitFor, shot) {
  console.error('->', name, new Date().toISOString().slice(11, 19));
  const t0 = Date.now();
  await page.goto(base + url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.error('goto', e.message.split('\n')[0]));
  try {
    await page.waitForFunction(waitFor, null, { timeout: 120000, polling: 500 });
    results.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
  }
  if (shot) await page.screenshot({ path: join(outDir, shot) });
}

// Partial address "9922 S Figueroa" once resolved to a place named "Figueroa" in Paramount.
// Free-text submit must land on the right address or offer it; never a wrong match.
await page.goto(base);
await page.fill('#q', '9922 S Figueroa');
await page.press('#q', 'Enter');
await page.waitForSelector('.didyoumean button, .matched', { timeout: 60000 }).catch(() => null);
const enterOutcome = (await page.textContent('#report').catch(() => '')) || '';
results.push({
  name: 'free-text "9922 S Figueroa" → right address or "did you mean", never a wrong match',
  ok: /9922 S Figueroa St, Los Angeles/.test(enterOutcome) && !/PARAMOUNT/i.test(enterOutcome),
  outcome: enterOutcome.slice(0, 160).replace(/\s+/g, ' '),
});
// Picking from the suggestion list.
await page.goto(base);
await page.fill('#q', '9922 S Figueroa');
await page.waitForSelector('#suggestions li', { timeout: 20000 }).catch(() => null);
const sugg = await page.$$eval('#suggestions li', (els) => els.map((e) => e.textContent)).catch(() => []);
if (sugg.length) await page.click('#suggestions li', { timeout: 10000 }).catch(() => null);
await page.waitForSelector('.matched', { timeout: 60000 }).catch(() => null);
const matched = await page.textContent('.matched').catch(() => '');
results.push({ name: 'suggestion list → 9922 S Figueroa St, Los Angeles', ok: /9922 S Figueroa St, Los Angeles/.test(matched || ''), sugg: sugg.slice(0, 3), matched });

await page.setViewportSize({ width: 1400, height: 2600 });
await check('address lookup (Oakland)', '?q=1221%20Broadway%2C%20Oakland%2C%20CA', () => document.querySelector('.verdict h3'), 'lookup-oakland.png');
const verdict = await page.textContent('.verdict h3').catch(() => null);
const chips = await page.$$eval('.chip', (els) => els.map((e) => e.textContent)).catch(() => []);
await page.setViewportSize({ width: 1400, height: 2600 });
await check('address lookup (San Francisco)', '?q=1%20Embarcadero%20Center%2C%20San%20Francisco', () => document.querySelector('.verdict h3'), 'lookup-sf.png');
await check('point lookup (LA City Hall)', '?pt=-118.2428,34.0537', () => document.querySelector('.verdict h3'), 'lookup-la.png');
await check('AB 2011 card (3600 Wilshire Blvd)', '?q=3600%20Wilshire%20Blvd%2C%20Los%20Angeles%2C%20CA', () => document.querySelector('.ab-path summary'), 'ab2011-wilshire.png');
const abText = await page.$$eval('.ab-path summary', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
results.push({ name: 'AB 2011: mixed-income path possibly eligible on Wilshire', ok: abText.some((t) => /Possibly eligible\s+Mixed-income/.test(t)), abText });
const exText = await page.$$eval('.card h2', (els) => els.filter((e) => /Site exclusions/.test(e.textContent)).map((e) => e.parentElement.textContent)).catch(() => []);
const exEval = await page.$$eval('.card.exclusions .ab-not-evaluated b', (els) => els.map((e) => e.textContent)).catch(() => []);
results.push({ name: 'Site exclusions: every source answered', ok: exEval.length === 0, notEvaluated: exEval });
results.push({ name: 'Site exclusions card: all 11 checks (A)–(K) rendered', ok: exText.length === 1 && ['(A)', '(B)', '(C)', '(D)', '(E)', '(F)', '(G)', '(H)', '(I)', '(J)', '(K)'].every((x) => exText[0].includes(`65913.4(a)(6)${x}`)) });
const abCites = await page.$$eval('.ab-mini .cite', (els) => els.map((e) => e.textContent)).catch(() => []);
results.push({ name: 'AB 2011 lists each § 65913.4(a)(6) exclusion on both paths', ok: abCites.filter((c) => /65913\.4\(a\)\(6\)\([A-K]\)/.test(c)).length >= 22 });
await page.setViewportSize({ width: 1400, height: 900 });
await check('parcel layer (downtown LA, z17)', '#17/34.04870/-118.25860', () => /(in a TOD zone|Parcels:|parcels: )/.test(document.getElementById('map-status')?.textContent || ''), 'parcels-la.png');
const parcelStatus = await page.textContent('#map-status').catch(() => null);
// Zooming in within the loaded area must not re-query the county or re-classify.
let parcelRequests = 0;
const countParcels = (r) => { if (/Parcels|ZNET|acdm-wktn/i.test(r.url()) && r.url().includes('query')) parcelRequests++; };
page.on('request', countParcels);
const tZoom = Date.now();
await page.click('.leaflet-control-zoom-in', { timeout: 10000 }).catch((e) => results.push({ name: 'zoom click', ok: false, error: e.message.split('\n')[0] }));
await page.waitForTimeout(2500);
page.off('request', countParcels);
results.push({ name: 'zoom in reuses loaded parcels (no county re-query)', ok: parcelRequests === 0, ms: Date.now() - tZoom, parcelRequests });
await check('parcel layer (SF Civic Center, z17)', '?sf=1#17/37.77950/-122.41500', () => /(in a TOD zone|Parcels:|parcels: )/.test(document.getElementById('map-status')?.textContent || ''), 'parcels-sf.png');
const parcelStatusSF = await page.textContent('#map-status').catch(() => null);
await check('fire exclusion (San Diego canyon, z17)', '?sd=1#17/32.76731/-117.14333', () => /(in a TOD zone|Parcels:|parcels: )/.test(document.getElementById('map-status')?.textContent || ''), 'fire-sd.png');
const fireStatusSD = await page.textContent('#map-status').catch(() => null);
await check('fire overlay (Glendale, z15)', '?gl=1#15/34.14855/-118.22631', () => /level 17/.test(document.getElementById('map-status')?.textContent || ''), null);
await page.waitForTimeout(5000);
await page.screenshot({ path: join(outDir, 'fire-glendale.png') });

console.log(JSON.stringify({ fireStatusSD, tiles: { ok: tileStats.ok, bad: tileStats.bad.slice(0, 5) }, results, verdict, chips, parcelStatus, parcelStatusSF, consoleErrors: consoleErrors.slice(0, 10) }, null, 2));
await browser.close();
server.close();
process.exit(results.every((r) => r.ok) && tileStats.ok > 0 && !tileStats.bad.length ? 0 : 1);
