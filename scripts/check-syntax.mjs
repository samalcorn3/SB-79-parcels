#!/usr/bin/env node
// Parse every browser and library module. A duplicate declaration or other
// syntax error in src/ui/*.js stops the whole site from loading, and the unit
// tests (which import only some modules) would not notice.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = ['src/lib', 'src/ui', 'scripts'].flatMap((d) =>
  readdirSync(join(root, d)).filter((f) => /\.m?js$/.test(f)).map((f) => join(root, d, f)));
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error(`Syntax error in ${f.replace(root, '')}:\n${e.stderr.toString().split('\n').slice(0, 5).join('\n')}`);
  }
}
if (bad) process.exit(1);
console.log(`Syntax OK: ${files.length} files`);
