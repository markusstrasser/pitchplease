// The build tooling: the worklet mini-bundler refuses what it cannot bundle faithfully, and the scripts run when
// invoked through a symlinked path.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, verifyExports } from '../scripts/bundle.mjs';
import { bundleWorklet } from '../scripts/build.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function toy(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-bundle-'));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return (name) => join(dir, name);
}
const run = (code) => { const out = {}; new Function('out', code)(out); return out; };

describe('scripts/bundle.mjs', () => {
  test('the shipped worklet: every inlined module exports exactly what the bundler found', async () => {
    expect(await verifyExports(bundleWorklet())).toEqual([]);
  });

  test('a named import that the target does not export is an error, not undefined', () => {
    const f = toy({ 'a.js': 'export const x = 1;\n', 'main.js': "import { missing } from './a.js';\nout.v = missing;\n" });
    expect(() => bundle(f('main.js'), '')).toThrow(/imports 'missing', which .\/a.js does not export/);
  });

  test("'export let' is refused", () => {
    const f = toy({ 'a.js': 'export let n = 0;\nexport function bump() { n++; }\n', 'main.js': "import { n } from './a.js';\nout.v = n;\n" });
    expect(() => bundle(f('main.js'), '')).toThrow(/cannot bundle 'export let'/);
  });

  test('two declarators in one export are caught by verifyExports()', async () => {
    const f = toy({ 'm.js': 'export const a = 1, b = 2;\n', 'main.js': "import * as M from './m.js';\nout.v = [M.a, M.b];\n" });
    const b = bundle(f('main.js'), '');
    expect(run(b.code).v).toEqual([1, undefined]); // what would ship without the check
    expect((await verifyExports(b)).join()).toMatch(/m.js: exports a, b, the bundler found a/);
  });

  test('modules whose names differ only in punctuation stay apart', () => {
    const f = toy({
      'a-b.js': 'export const which = "dash";\n', 'a_b.js': 'export const which = "underscore";\n',
      'main.js': "import { which as d } from './a-b.js';\nimport { which as u } from './a_b.js';\nout.v = [d, u];\n",
    });
    expect(run(bundle(f('main.js'), '').code).v).toEqual(['dash', 'underscore']);
  });
});

describe('scripts run through a symlinked path (as /tmp is on macOS)', () => {
  test('build --check and vendor --check still run their checks', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'pp-link-')), 'repo');
    symlinkSync(ROOT, link);
    expect(execFileSync('node', [join(link, 'scripts/build.mjs'), '--check'], { encoding: 'utf8' })).toMatch(/engine\/worklet.js is up to date/);
    expect(execFileSync('node', [join(link, 'scripts/vendor.mjs'), '--check'], { encoding: 'utf8' })).toMatch(/vendored files match/);
  });
});
