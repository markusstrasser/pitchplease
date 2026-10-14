// The trained-model engine: analyze() against the kernel run directly, the packed weights against their source,
// the vendored kernel against its recorded hash, the generated worklet against its sources, and the model metadata.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '../pitchplease.js';
import { unpackModel, packModel, modelUrl } from '../engine/models.js';
import { CHOICES, kernelSupported } from '../engine/kernels.js';
import { MODEL_SOURCES, workletSource } from '../scripts/build.mjs';
import { checkVendored } from '../scripts/vendor.mjs';
import { readWav } from './helpers/wav.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PITCHTEST_WEB = `${ROOT}../pitchtest/web/`; // the source repo, when checked out next to this one
const HAVE_SOURCE = existsSync(`${PITCHTEST_WEB}incport.js`);
const FIXTURES = ['piano-maestro', 'guitar-guitarset', 'voice-dcs'];
const TRAINED = ['fast', 'piano', 'voice'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// The reference: pitchtest's own incport.js and exported weights when available, else the vendored copy and the
// packed weights (the hash and packing tests below tie those to the source).
const refKernel = HAVE_SOURCE ? await import(`${PITCHTEST_WEB}incport.js`) : await import('../engine/incport.js');
function refWeights(id) {
  if (HAVE_SOURCE) {
    const dir = `${PITCHTEST_WEB}${MODEL_SOURCES[id]}/`;
    return refKernel.parseWeights(JSON.parse(readFileSync(dir + 'manifest.json')), ab(readFileSync(dir + 'weights.bin')));
  }
  const { manifest, weights } = unpackModel(ab(readFileSync(`${ROOT}models/${id}.bin`)));
  return refKernel.parseWeights(manifest, weights);
}

// pitchtest's decode rule (web/parity.mjs active(), detectors.Track.active): per-key hysteresis
function activeKeys(frames, on, off) {
  const st = new Uint8Array(88);
  return frames.map((f) => {
    const keys = [];
    for (let k = 0; k < 88; k++) { st[k] = st[k] ? f.probs[k] > off : f.probs[k] > on; if (st[k]) keys.push(k + 21); }
    return keys;
  });
}

// Every kernel this runtime supports. The JS kernel must match incport.js bit for bit; a WASM kernel must decode the
// same keys with probabilities within 2e-4 (its own parity gate against the Python oracle).
const KERNELS = CHOICES.filter(kernelSupported).map((c) => c.id);
const TOLERANCE = { js: 0 };

describe('analyze() decodes exactly what incport.js decodes', () => {
  test('kernels under test', () => expect(KERNELS).toContain('js'));
  for (const kernel of KERNELS) for (const id of TRAINED) {
    for (const fx of FIXTURES) {
      test(`${kernel} kernel: ${id} on ${fx}`, async () => {
        const { samples, sampleRate } = readWav(`${ROOT}tests/fixtures/${fx}.wav`);
        expect(sampleRate).toBe(48000);
        const duration = samples.length / sampleRate;
        // Direct run in 128-sample quanta, then silence so the input's last frames come out; keep frames inside the input.
        const det = refKernel.createDetector(refWeights(id), { inputRate: 48000 });
        const all = [];
        for (let i = 0; i < samples.length; i += 128) all.push(...det.push(samples.subarray(i, i + 128)));
        const beforeTail = all.length;
        const zeros = new Float32Array(128);
        for (let i = 0; i < 0.5 * sampleRate; i += 128) all.push(...det.push(zeros));
        const ref = all.filter((f) => f.t < duration);
        const { on, off } = P.models.find((m) => m.id === id).threshold;
        const refKeys = activeKeys(ref, on, off);

        const frames = await P.analyze(samples, sampleRate, { model: id, kernel });
        expect(ref.length).toBeGreaterThan(beforeTail); // the tail matters: without it the last frames are lost
        expect(frames.length).toBe(ref.length);
        const tol = TOLERANCE[kernel] ?? 2e-4;
        let mismatches = 0, onFrames = 0, maxDp = 0;
        for (let i = 0; i < ref.length; i++) {
          const f = frames[i], r = ref[i];
          if (f.time !== r.t || f.emitTime !== r.emit) mismatches++;
          for (let k = 0; k < 88; k++) maxDp = Math.max(maxDp, Math.abs(f.probs[k] - r.probs[k]));
          const keys = f.notes.map((n) => n.midi);
          if (keys.join() !== refKeys[i].join()) mismatches++;
          onFrames += keys.length > 0;
        }
        expect(mismatches).toBe(0);
        expect(maxDp).toBeLessThanOrEqual(tol);
        expect(onFrames).toBeGreaterThan(ref.length / 2); // the fixtures are busy: a silent decode would pass vacuously
        // the frame clock: one frame per 256 samples at 22.05 kHz
        for (let i = 1; i < frames.length; i++) expect(Math.abs(frames[i].time - frames[i - 1].time - 256 / 22050)).toBeLessThan(1e-9);
      }, 120_000);
    }
  }
});

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
    expect(pkg.files).toEqual(expect.arrayContaining(['pitchplease.js', 'pitchplease.d.ts', 'engine/', 'models/']));
    expect(pkg.dependencies).toBeUndefined();
  });
  test('the type declarations list every model id', () => {
    const dts = readFileSync(`${ROOT}pitchplease.d.ts`, 'utf8');
    const m = /type ModelId = ([^;]+);/.exec(dts);
    expect(m).not.toBeNull();
    expect(m[1].split('|').map((s) => s.trim().replace(/'/g, ''))).toEqual(P.models.map((x) => x.id));
  });
});
