// Every number in data/standards.json must match the statute text pulled from
// the Legislative Counsel's leginfo database (data/statute/65912.157.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadData } from '../scripts/load-data.mjs';
import { standardsFor, computeStandards, minUnitsForLot, projectRequirements } from '../src/lib/standards.js';

const text = await readFile(new URL('../data/statute/65912.157.txt', import.meta.url), 'utf8');
const { standards } = await loadData();
const num = (re, s = text) => {
  const m = s.match(re);
  assert.ok(m, `statute text did not match ${re}`);
  return Number(m[1]);
};
// Paragraph (n) of subdivision (a): from "(n)For a transit-oriented…" up to the next numbered paragraph.
function para(n) {
  const start = text.indexOf(`(${n})For a transit-oriented housing development project`);
  assert.ok(start > -1, `paragraph (a)(${n}) not found`);
  const end = text.indexOf(`(${n + 1})For a transit-oriented`, start);
  return text.slice(start, end > -1 ? end : text.indexOf('(b)For purposes', start));
}

const MAP = { 3: ['1', 'quarter'], 4: ['1', 'half'], 5: ['2', 'quarter'], 6: ['2', 'half'] };

for (const [n, [tier, band]] of Object.entries(MAP)) {
  test(`§ 65912.157(a)(${n}) → Tier ${tier} ${band}`, () => {
    const p = para(Number(n));
    const s = standards.tiers[tier][band];
    assert.match(p, new RegExp(`Tier ${tier} transit-oriented`));
    assert.equal(s.heightFt, num(/height limit less than (\d+) feet/, p));
    assert.equal(s.densityDuAc, num(/density(?: standard)? of less than (\d+) dwelling units per acre/, p));
    assert.equal(s.far, num(/floor area ratio of up to\s+([\d.]+?)\.?\n/, `${p}\n`));
    assert.equal(s.concessionDensityDuAc, num(/achieves a minimum density of (\d+) dwelling units per acre/, p));
    assert.equal(s.cite, `§ 65912.157(a)(${n})`);
    if (band === 'half') assert.equal(s.minCityPopulation, num(/population of at least ([\d,]+)/, p.replace(/,/g, '')));
  });
}

test('§ 65912.157(e) adjacency intensifier', () => {
  const e = text.slice(text.indexOf('(e)Notwithstanding'));
  const ai = standards.adjacencyIntensifier;
  assert.equal(ai.heightFt, num(/height limit by an additional (\d+) feet/, e));
  assert.equal(ai.densityDuAc, num(/additional (\d+) dwelling units per acre/, e));
  assert.equal(ai.far, num(/floor area ratio by (\d+)/, e));
});

test('§ 65912.157(a)(1)–(2), (i), (k) project requirements', () => {
  assert.equal(standards.general.minUnits.value, 5);
  assert.match(text, /at least five dwelling units/);
  assert.equal(standards.general.minDensityDuAc.value, num(/minimum density of at least (\d+) dwelling units per acre/));
  assert.equal(standards.general.maxAvgUnitNetSqFt.value, num(/shall not exceed ([\d,]+) net habitable/, text.replace(/(\d),(\d)/g, '$1$2')));
  const pcts = [...text.matchAll(/At least (\d+) percent of the total units/g)].map((m) => Number(m[1]));
  assert.deepEqual(standards.affordability.options.map((o) => o.pct), pcts);
  assert.equal(standards.affordability.appliesAboveUnits, num(/development of (\d+) units or less/));
  assert.equal(standards.labor.heightFtOver, num(/any building over (\d+) feet in height/));
});

test('adjacent = tier ¼-mile standards + intensifier (Tier 1: 95/160/4.5, Tier 2: 85/140/4.0)', () => {
  const a1 = standardsFor(standards, 1, 'adjacent');
  const a2 = standardsFor(standards, 2, 'adjacent');
  assert.deepEqual([a1.heightFt, a1.densityDuAc, a1.far], [95, 160, 4.5]);
  assert.deepEqual([a2.heightFt, a2.densityDuAc, a2.far], [85, 140, 4.0]);
  assert.equal(a1.cite, '§ 65912.157(a)(3) + § 65912.157(e)');
});

test('lot-level requirements', () => {
  const std = computeStandards(standards, [{ tier: 2, band: 'quarter' }]);
  const r = projectRequirements(standards, std, 43560); // one acre
  assert.deepEqual([r.minUnits, r.maxUnits, r.floorAreaSqFt, r.concessionUnits], [30, 100, 130680, 75]);
  assert.equal(r.affordabilityApplies, true);
  assert.equal(minUnitsForLot(standards, 2000), 5); // 30 du/ac on 2,000 sq ft is 2 units, so the 5-unit floor governs
  assert.equal(projectRequirements(standards, computeStandards(standards, [{ tier: 1, band: 'adjacent' }]), 5000).laborStandardsPossible, true);
});

test('local statute copy came from leginfo and reflects SB 722', async () => {
  const m = JSON.parse(await readFile(new URL('../data/statute/manifest.json', import.meta.url), 'utf8'));
  assert.match(m.archive, /^https:\/\/downloads\.leginfo\.legislature\.ca\.gov\//);
  assert.match(m.sections['65912.157'].history, /Ch\. 100.*SB 722/);
  assert.match(text, /Mobilehome Residency Law/);
});
