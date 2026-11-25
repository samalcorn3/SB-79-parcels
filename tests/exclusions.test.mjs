// § 65913.4(a)(6) site exclusions: which laws apply them, and the decision rules,
// checked against the statute text pulled from leginfo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exclusionsStatus, exclusionsFor, lcpCertification } from '../src/lib/exclusions.js';

const read = (s) => readFile(new URL(`../data/statute/${s}.txt`, import.meta.url), 'utf8');
const [s4, s111, s121, s159] = await Promise.all(['GOV-65913.4', '65912.111', '65912.121', '65912.159'].map(read));
const sources = JSON.parse(await readFile(new URL('../data/sources.json', import.meta.url), 'utf8'));

test('AB 2011 applies all of § 65913.4(a)(6) except (A)(iv), on both paths', () => {
  const phrase = /satisfies the requirements specified in paragraph \(6\) of subdivision \(a\) of Section\s+65913\.4, exclusive of clause \(iv\) of subparagraph \(A\)/;
  assert.match(s111, phrase);
  assert.match(s121, phrase);
});

test('SB 79 applies § 65913.4 only on the streamlined ministerial path', () => {
  assert.match(s159, /\(a\)A housing development project proposed pursuant to Section 65912\.157 shall be eligible for streamlined ministerial approval pursuant to Section 65913\.4/);
  assert.match(s159, /\(3\)The proposed project shall comply with all other requirements of Section\s+65913\.4/);
  assert.match(s159, /\(b\)Any housing development proposed pursuant to Section 65912\.157 not seeking streamlined approval under Section 65913\.4 shall be reviewed according to the jurisdiction’s development review process/);
});

test('each check matches its subparagraph of § 65913.4(a)(6)', () => {
  const a6 = s4.slice(s4.indexOf('(6)The development is not located on a site that is any of the following'), s4.indexOf('(7)The development is not located on a site where'));
  const sub = (L) => {
    // Subparagraphs start a line; skip subclauses such as (A)(v)(I) that share a letter.
    const lines = a6.split('\n');
    const n = lines.findIndex((ln, k) => ln.startsWith(`(${L})`) && (L !== 'I' || lines.slice(0, k).some((p) => p.startsWith('(H)'))));
    const i = n < 0 ? -1 : lines.slice(0, n).join('\n').length + 1;
    assert.ok(i >= 0, `subparagraph (${L}) not found`);
    return a6.slice(i, i + 400);
  };
  assert.match(sub('A'), /coastal zone/);
  assert.match(sub('B'), /prime farmland or farmland of statewide importance.*Farmland Mapping and Monitoring Program/s);
  assert.match(sub('C'), /Wetlands, as defined in the United States Fish and Wildlife Service Manual/);
  assert.match(sub('D'), /very high fire hazard\s+severity zone/);
  assert.match(sub('E'), /hazardous waste site that is listed pursuant to Section 65962\.5/);
  assert.match(sub('F'), /earthquake fault zone as determined by the State Geologist/);
  assert.match(sub('G'), /special flood hazard area.*Federal Emergency Management Agency/s);
  assert.match(sub('H'), /regulatory floodway/);
  assert.match(sub('I'), /natural community conservation plan/);
  assert.match(sub('J'), /Habitat for protected species/);
  assert.match(sub('K'), /conservation easement/);
});

const items = (...statuses) => statuses.map((status, i) => ({ id: `x${i}`, sub: 'B', cite: '§ 65913.4(a)(6)(B)', status, detail: 'd' }));

test('overall status: any exclusion fails; all clear meets; otherwise confirm', () => {
  assert.equal(exclusionsStatus(items('meets', 'meets')), 'meets');
  assert.equal(exclusionsStatus(items('meets', 'fails', 'confirm')), 'fails');
  assert.equal(exclusionsStatus(items('meets', 'none-mapped')), 'confirm');
  assert.equal(exclusionsStatus(items('meets', 'not-evaluated')), 'confirm');
});

test('AB 2011 view drops coastal clause (iv); SB 79 view keeps it', () => {
  const r = { items: [{ id: 'coastal', sub: 'A', cite: '§ 65913.4(a)(6)(A)', status: 'confirm', detail: 'In the zone. Clause (iv), parcels not zoned for multifamily housing, applies to SB 79 but not to AB 2011. End.' }] };
  const ab = exclusionsFor('ab2011', r)[0];
  assert.doesNotMatch(ab.detail, /Clause \(iv\)/);
  assert.match(ab.detail, /End\./);
  assert.match(ab.cite, /65912\.111\(e\).*65912\.121\(g\).*except \(A\)\(iv\)/);
  const sb = exclusionsFor('sb79', r)[0];
  assert.match(sb.detail, /Clause \(iv\)/);
  assert.match(sb.cite, /65912\.159\(a\)\(3\)/);
});

test('coastal clause (A)(ii): certified LCP or LUP required', () => {
  assert.equal(lcpCertification({ Name: 'X', LCPCert: 'Y' }).status, 'ok');
  assert.equal(lcpCertification({ Name: 'X', LCPCert: 'N', Effec_Cert: 'N', LUPDate: 992476800000 }).status, 'ok');
  assert.equal(lcpCertification({ Name: 'X', LCPCert: 'N', Effec_Cert: 'N', LUPDate: null }).status, 'fails');
  assert.equal(lcpCertification({ Name: 'X ADC', LCPCert: 'N', Effec_Cert: 'Y', UncertArea: 'Y' }).status, 'confirm');
  assert.equal(lcpCertification({ Name: 'Golden Gate NRA', NonLCP: 'Y' }).status, 'confirm');
  assert.equal(lcpCertification(null).status, 'confirm');
});

test('every exclusion source is an agency service, not a third-party copy', () => {
  const x = sources.siteExclusions;
  const urls = [x.coastalZone.url, x.lcpSegments.url, x.farmland.folder, x.wetlands.url, ...x.hazardous.layers.map((l) => l.url), x.faultZones.url, x.flood.url, x.conservationPlans.url, x.criticalHabitat.url, x.agEasements.url];
  const owners = [
    /services9\.arcgis\.com\/wwVnNW92ZHUIr0V0\//, // California Coastal Commission
    /gis\.conservation\.ca\.gov\//, // Department of Conservation
    /services2\.arcgis\.com\/zr3KAIbsRSUyARHG\//, // Department of Conservation (CGS)
    /fwspublicservices\.wim\.usgs\.gov\//, // USFWS National Wetlands Inventory
    /services\.arcgis\.com\/QVENGdaPbd4LUkLV\//, // USFWS
    /services3\.arcgis\.com\/Oy2JTCD10wkoelxS\//, // DTSC
    /hazards\.fema\.gov\//, // FEMA
    /services2\.arcgis\.com\/Uq9r85Potqm3MfRV\//, // CDFW BIOS
  ];
  for (const u of urls) assert.ok(owners.some((re) => re.test(u)), `unrecognised publisher: ${u}`);
});
