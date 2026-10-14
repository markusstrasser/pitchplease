// The build tooling: the worklet mini-bundler refuses what it cannot bundle faithfully, and the scripts run when
// invoked through a symlinked path.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, verifyExports } from '../scripts/bundle.mjs';
import { bundleWorklet } from '../scripts/build.mjs';
import * as build from '../scripts/build.mjs';
import { MODELS, unpackModel } from '../engine/models.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function toy(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-bundle-'));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return (name) => join(dir, name);
}
const run = (code) => { const out = {}; new Function('out', code)(out); return out; };

const RELEASE_OUTPUTS = ['engine/worklet.js', 'engine/kernels.js', 'engine/vendor.json', ...Object.keys(build.MODEL_SOURCES).map(id => `models/${id}.bin`)];
const releaseSnapshot = (root) => Object.fromEntries(RELEASE_OUTPUTS.map(path => [path, readFileSync(join(root, path))]));

function modelBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pp-model-build-'));
  for (const name of ['engine', 'models', 'scripts', 'package.json']) cpSync(join(ROOT, name), join(root, name), { recursive: true });
  // Make generated outputs stale so an early write cannot hide behind identical bytes.
  writeFileSync(join(root, 'engine/worklet.js'), '// previous release worklet\n');
  const kernels = join(root, 'engine/kernels.js');
  const vendor = JSON.parse(readFileSync(join(root, 'engine/vendor.json')));
  writeFileSync(kernels, readFileSync(kernels, 'utf8').replace(vendor['incport-relaxed.wasm'].sha256, '0'.repeat(64)));
  const pitchtest = mkdtempSync(join(tmpdir(), 'pp-model-source-'));
  // Borrow read-only Git metadata solely for source provenance; never stage or commit a fixture.
  symlinkSync(execFileSync('git', ['-C', ROOT, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), join(pitchtest, '.git'));
  for (const [id, dir] of Object.entries(build.MODEL_SOURCES)) {
    const bytes = readFileSync(join(ROOT, 'models', `${id}.bin`));
    const { manifest, weights } = unpackModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), id);
    const source = join(pitchtest, 'web', dir);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(source, 'weights.bin'), Buffer.from(weights));
  }
  return { root, pitchtest };
}

function rebuildModels({ root, pitchtest }) {
  return execFileSync('node', [join(root, 'scripts/build.mjs'), '--models'], {
    env: { ...process.env, PITCHTEST: pitchtest, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('model release consistency', () => {
  test.each(['piano', 'voice'])('a %s validation failure leaves every release output untouched', (id) => {
    const fixture = modelBuildFixture();
    const weightsFile = join(fixture.pitchtest, 'web', build.MODEL_SOURCES[id], 'weights.bin');
    const bytes = readFileSync(weightsFile);
    bytes.writeFloatLE(bytes.readFloatLE(0) + 0.125, 0);
    writeFileSync(weightsFile, bytes);
    const before = releaseSnapshot(fixture.root);
    let failure;
    try { rebuildModels(fixture); } catch (e) { failure = e; }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain(`${id}: weights revision`);
    expect(RELEASE_OUTPUTS.filter(path => !readFileSync(join(fixture.root, path)).equals(before[path]))).toEqual([]);
  }, 15_000);

  test('a successful model rebuild writes the validated models and generated outputs together', () => {
    const fixture = modelBuildFixture();
    const before = releaseSnapshot(fixture.root);
    expect(rebuildModels(fixture)).toContain('models/voice.bin');
    expect(build.checkModels({ root: fixture.root })).toEqual([]);
    for (const path of RELEASE_OUTPUTS) expect(readFileSync(join(fixture.root, path)).equals(before[path])).toBe(false);
    expect(execFileSync('node', [join(fixture.root, 'scripts/build.mjs'), '--check'], { encoding: 'utf8' })).toContain('models: revisions, payload hashes, thresholds and provenance agree');
  }, 15_000);

  test('model rebuild refuses uncommitted exporter/kernel code at the PITCHTEST path', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-model-build-'));
    for (const name of ['engine', 'models', 'scripts', 'package.json']) cpSync(join(ROOT, name), join(root, name), { recursive: true });
    const pitchtest = mkdtempSync(join(tmpdir(), 'pp-model-source-'));
    mkdirSync(join(pitchtest, 'web'));
    execFileSync('git', ['-C', pitchtest, 'init', '-q']); // temporary test fixture; no workspace Git writes
    for (const name of ['export.py', 'incport.js']) writeFileSync(join(pitchtest, 'web', name), 'uncommitted exporting code');
    let output = '';
    try {
      execFileSync('node', [join(root, 'scripts/build.mjs'), '--models'], {
        env: { ...process.env, PITCHTEST: pitchtest }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { output = e.stderr; }
    expect(output).toMatch(/Refusing to build models.*uncommitted changes/);
    expect(output).toContain('web/export.py');
    expect(output).toContain('web/incport.js');
  });

  test('build checks payload revision, registry, threshold and vendor entry without pitchtest', () => {
    expect(typeof build.checkModels).toBe('function');
    expect(build.checkModels()).toEqual([]);
    const altered = MODELS.map(m => m.id === 'fast' ? { ...m, threshold: { on: 0.8, off: 0.48 } } : m);
    expect(build.checkModels({ models: altered }).join()).toMatch(/fast.*threshold/);
    expect(build.checkModels({ models: MODELS.map(m => m.id === 'fast' ? { ...m, threshold: null } : m) }).join()).toMatch(/fast.*threshold/);
    expect(build.checkModels({ models: MODELS.filter(m => m.id !== 'fast') }).join()).toMatch(/fast.*missing/);
    const revision = MODELS.map(m => m.id === 'fast' ? { ...m, revision: '000000000000' } : m);
    expect(build.checkModels({ models: revision }).join()).toMatch(/fast.*revision/);
    const root = mkdtempSync(join(tmpdir(), 'pp-model-check-'));
    for (const name of ['engine', 'models']) cpSync(join(ROOT, name), join(root, name), { recursive: true });
    const vendorFile = join(root, 'engine/vendor.json');
    const vendor = JSON.parse(readFileSync(vendorFile));
    vendor.models.fast.threshold.on = 0.8;
    writeFileSync(vendorFile, JSON.stringify(vendor));
    expect(build.checkModels({ root }).join()).toMatch(/fast.*vendor.json.*threshold/);
    const weightsFile = join(root, 'models/piano.bin'), bytes = readFileSync(weightsFile);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(weightsFile, bytes);
    expect(build.checkModels({ root }).join()).toMatch(/piano.*payload.*revision/);
  });
});

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
