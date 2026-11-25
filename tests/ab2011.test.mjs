// Every AB 2011 figure the site uses must match the statute text pulled from leginfo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AB2011 } from '../src/lib/ab2011.js';

const read = (s) => readFile(new URL(`../data/statute/${s}.txt`, import.meta.url), 'utf8');
const [s101, s121, s123] = await Promise.all(['65912.101', '65912.121', '65912.123'].map(read));
const num = (re, text) => {
  const m = text.match(re);
  assert.ok(m, `statute text did not match ${re}`);
  return Number(m[1].replace(/,/g, ''));
};

test('§ 65912.101(c): commercial corridor right-of-way 70–150 ft', () => {
  assert.equal(AB2011.corridor.minFt, num(/right-of-way of at least (\d+) and/, s101));
  assert.equal(AB2011.corridor.maxFt, num(/not greater than (\d+) feet/, s101));
});

test('§ 65912.121(c)–(d): 50-ft frontage; 20 acres (100 for a regional mall)', () => {
  assert.equal(AB2011.corridor.minFrontageFt, num(/frontage along the commercial corridor of a minimum of (\d+) feet/, s121));
  assert.equal(AB2011.maxAcres, num(/not greater than (\d+) acres, unless/, s121));
  assert.equal(AB2011.maxAcresRegionalMall, num(/regional mall, in which case the site is not greater than (\d+) acres/, s121));
});

test('§ 65912.123(b): density tables', () => {
  const b1 = s123.slice(s123.indexOf('(1)In a metropolitan jurisdiction'), s123.indexOf('(2)In a jurisdiction that is not'));
  const b2 = s123.slice(s123.indexOf('(2)In a jurisdiction that is not'), s123.indexOf('(3)(A)'));
  for (const [t, d] of [[b1, AB2011.density.metropolitan], [b2, AB2011.density.other]]) {
    assert.equal(d.smallSite, num(/less than one acre in size, (\d+) units per acre/, t));
    assert.equal(d.narrowCorridor, num(/less than 100 feet in width, (\d+) units per acre/, t));
    assert.equal(d.wideCorridor, num(/100 feet in width or greater, (\d+)\s+units\s+per acre/, t));
    assert.equal(d.transitOrCampus, num(/campus development zone, (\d+) units per acre/, t));
  }
  assert.equal(AB2011.corridor.wideFt, 100);
});

test('§ 65912.123(c), (f): heights and the 500-ft freeway rule', () => {
  assert.equal(AB2011.height.narrowCorridor, num(/less than 100 feet in width, (\d+) feet/, s123));
  assert.equal(AB2011.height.wideCorridor, num(/100 feet in width or greater, (\d+) feet/, s123));
  assert.equal(AB2011.height.transit, num(/(\d+) feet for sites that meet all of the following/, s123));
  assert.equal(AB2011.height.transitMinCityPop, num(/population of greater than ([\d,]+)/, s123));
  assert.equal(AB2011.freewayBufferFt, num(/within (\d+)\s+feet of a freeway/, s123));
});
