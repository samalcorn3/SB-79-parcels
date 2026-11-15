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
await page.route('https://*.basemaps.cartocdn.com/**', (r) => r.fulfill({ status: 204 }));

const results = [];
async function check(name, url, waitFor, shot) {
  console.error('->', name);
  const t0 = Date.now();
  await page.goto(base + url);
  try {
    await page.waitForFunction(waitFor, null, { timeout: 120000, polling: 500 });
    results.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
  }
  if (shot) await page.screenshot({ path: join(outDir, shot) });
}

await check('address lookup (Oakland)', '?q=1221%20Broadway%2C%20Oakland%2C%20CA', () => document.querySelector('.verdict h3'), 'lookup-oakland.png');
const verdict = await page.textContent('.verdict h3').catch(() => null);
const chips = await page.$$eval('.chip', (els) => els.map((e) => e.textContent)).catch(() => []);
await page.setViewportSize({ width: 1400, height: 2600 });
await check('address lookup (San Francisco)', '?q=1%20Embarcadero%20Center%2C%20San%20Francisco', () => document.querySelector('.verdict h3'), 'lookup-sf.png');
await check('point lookup (LA City Hall)', '?pt=-118.2428,34.0537', () => document.querySelector('.verdict h3'), 'lookup-la.png');
await page.setViewportSize({ width: 1400, height: 900 });
await check('parcel layer (downtown LA, z17)', '#17/34.04870/-118.25860', () => /(\d parcels|Parcels:|parcels: )/.test(document.getElementById('map-status')?.textContent || ''), 'parcels-la.png');
const parcelStatus = await page.textContent('#map-status').catch(() => null);
await check('parcel layer (SF Civic Center, z17)', '?sf=1#17/37.77950/-122.41500', () => /(\d parcels|Parcels:|parcels: )/.test(document.getElementById('map-status')?.textContent || ''), 'parcels-sf.png');
const parcelStatusSF = await page.textContent('#map-status').catch(() => null);

console.log(JSON.stringify({ results, verdict, chips, parcelStatus, parcelStatusSF, consoleErrors: consoleErrors.slice(0, 10) }, null, 2));
await browser.close();
server.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
