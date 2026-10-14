// The trained-model engine: the packed weights against their source, the vendored kernel against its recorded hash,
// the generated worklet against its sources, and the model metadata. analyze() against the kernel: tests/parity/.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as P from '../pitchplease.js';
import { unpackModel, packModel, modelUrl } from '../engine/models.js';
import { CHOICES } from '../engine/kernels.js';
import { MODEL_SOURCES, workletSource } from '../scripts/build.mjs';
import { checkVendored } from '../scripts/vendor.mjs';
import { HAVE_SOURCE, PITCHTEST_WEB, refKernel, refWeights } from './helpers/parity.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TRAINED = ['fast', 'piano', 'voice'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

describe('packed models', () => {
  for (const id of TRAINED) {
    test(`${id}: header, provenance and tensors`, () => {
      const file = readFileSync(`${ROOT}models/${id}.bin`);
      const { header, manifest, weights } = unpackModel(ab(file));
      expect(header.model).toBe(id);
      expect(header.source.dir).toBe(`pitchtest/web/${MODEL_SOURCES[id]}`);
      expect(header.source.dropped).toEqual(['c1_w', 'c4_b', 'c4_w', 'c5_b', 'c5_w']); // unused by the kernel
      const packed = refKernel.parseWeights(manifest, weights);
      expect('s2_w' in packed.tensors).toBe(id !== 'fast');
      if (!HAVE_SOURCE) return;
      const dir = `${PITCHTEST_WEB}${MODEL_SOURCES[id]}/`;
      expect(sha256(readFileSync(dir + 'manifest.json'))).toBe(header.source.manifestSha256);
      expect(sha256(readFileSync(dir + 'weights.bin'))).toBe(header.source.weightsSha256);
      const src = refWeights(id);
      for (const [k, t] of Object.entries(packed.tensors)) expect(Buffer.compare(Buffer.from(ab(t)), Buffer.from(ab(src.tensors[k])))).toBe(0);
    });
  }

  test('pack/unpack round trip', () => {
    const data = Float32Array.from({ length: 10 }, (_, i) => i / 3);
    for (const name of ['a', 'abc', 'abcdef']) { // header lengths that need 0-3 bytes of padding
      const header = { model: name, tensors: { x: { offset: 0, shape: [10] } }, const: {} };
      const u = unpackModel(packModel(header, data).buffer);
      expect(u.header).toEqual(header);
      expect(Array.from(new Float32Array(u.weights))).toEqual(Array.from(data));
    }
    expect(() => unpackModel(new ArrayBuffer(16))).toThrow(/bad magic/);
  });

  test('a truncated weights file is refused, not half-loaded', async () => {
    const header = { model: 'x', tensors: { a: { offset: 0, shape: [4] }, b: { offset: 4, shape: [2, 3] } }, const: {} };
    const whole = packModel(header, new Float32Array(10));
    expect(() => unpackModel(whole.buffer)).not.toThrow();
    expect(() => unpackModel(whole.buffer.slice(0, whole.length - 8))).toThrow(/tensor 'b' ends at float 10, the file holds 8/);
    expect(() => unpackModel(whole.buffer.slice(0, whole.length - 2))).toThrow(/not a whole number of floats/);
    expect(() => unpackModel(whole.buffer.slice(0, 20))).toThrow(/header runs past the end/);
    // and through the loader: the shipped fast.bin minus its last 2000 floats
    const dir = mkdtempSync(`${tmpdir()}/pp-truncated-`);
    const fast = readFileSync(`${ROOT}models/fast.bin`);
    writeFileSync(`${dir}/fast.bin`, fast.subarray(0, fast.length - 8000));
    const e = await P.analyze(new Float32Array(4800), 48000, { modelBaseUrl: pathToFileURL(dir + '/') }).catch((x) => x);
    expect(e.code).toBe('model-load-failed');
    expect(e.message).toMatch(/truncated weights file: tensor/);
  });
});

describe('vendored kernel and generated worklet', () => {
  test('vendored files match engine/vendor.json (sha256, header commit)', () => {
    expect(checkVendored({ upstream: false }).problems).toEqual([]);
  });
  test.skipIf(!HAVE_SOURCE)('vendored files are byte-identical to ../pitchtest/web (skipped without that checkout)', () => {
    expect(checkVendored({ upstream: true }).problems).toEqual([]);
  });
  test('engine/worklet.js is up to date with its sources (npm run build)', () => {
    expect(readFileSync(`${ROOT}engine/worklet.js`, 'utf8')).toBe(workletSource());
  });
});

describe('model metadata', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`));
  test('ids, defaults and fields', () => {
    expect(P.models.map((m) => m.id)).toEqual(['fast', 'piano', 'voice', 'fft']);
    expect(P.models.filter((m) => m.default).map((m) => m.id)).toEqual(['fast']);
    for (const m of P.models) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.useCase.length).toBeGreaterThan(10);
      for (const k of ['latencyMs', 'pianoF1', 'guitarF1', 'voiceF1']) expect(typeof m[k]).toBe('number');
    }
    const fft = P.models.find((m) => m.id === 'fft');
    expect(fft.threshold).toBeNull();
    expect(fft.relativeCost).toBeNull();
    expect(fft.sizeKB).toBe(0);
  });
  test('sizes match the shipped files', () => {
    for (const id of TRAINED) {
      const m = P.models.find((x) => x.id === id);
      expect(m.sizeKB).toBe(Math.round(statSync(fileURLToPath(modelUrl(id))).size / 1024));
    }
  });
  test('operating points and costs', () => {
    const t = Object.fromEntries(P.models.map((m) => [m.id, m.threshold]));
    expect(t.fast).toEqual({ on: 0.7, off: 0.42 });
    expect(t.piano).toEqual({ on: 0.6, off: 0.36 });
    expect(t.voice).toEqual({ on: 0.65, off: 0.39 });
    const cost = Object.fromEntries(P.models.map((m) => [m.id, m.relativeCost]));
    expect(cost).toEqual({ fast: 1, piano: 2.1, voice: 2.1, fft: null });
    // piano and voice run the same architecture: identical tensor shapes
    const shapes = (id) => JSON.stringify(Object.entries(unpackModel(ab(readFileSync(`${ROOT}models/${id}.bin`))).header.tensors).map(([k, v]) => [k, v.shape]));
    expect(shapes('piano')).toBe(shapes('voice'));
  });
  test('version, exports map and shipped files', () => {
    expect(P.version).toBe(pkg.version);
    expect(pkg.version).toBe('3.0.0');
    expect(pkg.type).toBe('module');
    expect(pkg.exports['.'].default).toBe('./pitchplease.js');
    // only what consumers need: narrowing after 3.0.0 would be breaking
    expect(Object.keys(pkg.exports)).toEqual(['.', './engine/worklet.js', './engine/*.wasm', './models/*', './package.json']);
    expect(pkg.files).toEqual(expect.arrayContaining(['pitchplease.js', 'pitchplease.d.ts', 'engine/', 'models/']));
    expect(pkg.dependencies).toBeUndefined();
  });
  test('the type declarations list every model id', () => {
    const dts = readFileSync(`${ROOT}pitchplease.d.ts`, 'utf8');
    const m = /type ModelId = ([^;]+);/.exec(dts);
    expect(m).not.toBeNull();
    expect(m[1].split('|').map((s) => s.trim().replace(/'/g, ''))).toEqual(P.models.map((x) => x.id));
  });
  test('every error code the code raises is declared and documented', () => {
    const dts = readFileSync(`${ROOT}pitchplease.d.ts`, 'utf8');
    const declared = new Set([.../type ErrorCode =([^;]+);/.exec(dts)[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]));
    const readme = readFileSync(`${ROOT}README.md`, 'utf8');
    const sources = ['pitchplease.js', ...readdirSync(`${ROOT}engine`).filter((f) => f.endsWith('.js')).map((f) => `engine/${f}`)];
    const raised = new Set(sources.flatMap((f) => [...readFileSync(`${ROOT}${f}`, 'utf8').matchAll(/new PitchPleaseError\('([\w-]+)'/g)].map((x) => x[1])));
    expect(raised.size).toBeGreaterThan(15);
    for (const code of raised) {
      expect([code, declared.has(code)]).toEqual([code, true]);
      expect([code, readme.includes(`\`${code}\``)]).toEqual([code, true]);
    }
  });
  test('the type declarations list every kernel choice', () => {
    const dts = readFileSync(`${ROOT}pitchplease.d.ts`, 'utf8');
    const m = /type KernelId = ([^;]+);/.exec(dts);
    expect(m).not.toBeNull();
    expect(m[1].split('|').map((s) => s.trim().replace(/'/g, ''))).toEqual(['auto', ...CHOICES.map((c) => c.id)]);
  });
});
