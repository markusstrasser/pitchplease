// analyze() against the detector kernel run directly, for one model on every fixture and every kernel this runtime
// supports. tests/parity/<model>.test.js call this, one file per model so `bun test --parallel` spreads them out.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '../../pitchplease.js';
import { unpackModel } from '../../engine/models.js';
import { CHOICES, kernelSupported } from '../../engine/kernels.js';
import { MODEL_SOURCES } from '../../scripts/build.mjs';
import { readWav } from './wav.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const PITCHTEST_WEB = `${ROOT}../pitchtest/web/`; // the source repo, when checked out next to this one
export const HAVE_SOURCE = existsSync(`${PITCHTEST_WEB}incport.js`);
const FIXTURES = ['piano-maestro', 'guitar-guitarset', 'voice-dcs'];
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// The reference: pitchtest's own incport.js and exported weights when available, else the vendored copy and the
// packed weights (tests/engine.test.js ties those to the source by hash and by packing).
export const refKernel = HAVE_SOURCE ? await import(`${PITCHTEST_WEB}incport.js`) : await import('../../engine/incport.js');
export function refWeights(id) {
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

// Direct run in 128-sample quanta, then silence so the input's last frames come out; keep frames inside the input.
function decodeDirect(id, samples, sampleRate) {
  const duration = samples.length / sampleRate;
  const det = refKernel.createDetector(refWeights(id), { inputRate: 48000 });
  const all = [];
  for (let i = 0; i < samples.length; i += 128) all.push(...det.push(samples.subarray(i, i + 128)));
  const beforeTail = all.length;
  const zeros = new Float32Array(128);
  for (let i = 0; i < 0.5 * sampleRate; i += 128) all.push(...det.push(zeros));
  const frames = all.filter((f) => f.t < duration);
  const { on, off } = P.models.find((m) => m.id === id).threshold;
  return { frames, keys: activeKeys(frames, on, off), beforeTail };
}

// Every kernel this runtime supports. The JS kernel must match incport.js bit for bit; a WASM kernel must decode the
// same keys with probabilities within 2e-4 (its own parity gate against the Python oracle).
export const KERNELS = CHOICES.filter(kernelSupported).map((c) => c.id);
const TOLERANCE = { js: 0 };

export function parityTests(id) {
  describe(`${id}: analyze() decodes exactly what incport.js decodes`, () => {
    test('kernels under test', () => expect(KERNELS).toContain('js'));
    for (const fx of FIXTURES) {
      let input, ref; // shared by every kernel: the direct decode is the expensive half
      const reference = () => {
        input ??= readWav(`${ROOT}tests/fixtures/${fx}.wav`);
        ref ??= decodeDirect(id, input.samples, input.sampleRate);
        return { ...input, ref };
      };
      for (const kernel of KERNELS) {
        test(`${kernel} kernel on ${fx}`, async () => {
          const { samples, sampleRate, ref: { frames: refFrames, keys: refKeys, beforeTail } } = reference();
          expect(sampleRate).toBe(48000);
          const frames = await P.analyze(samples, sampleRate, { model: id, kernel });
          expect(refFrames.length).toBeGreaterThan(beforeTail); // the tail matters: without it the last frames are lost
          expect(frames.length).toBe(refFrames.length);
          const tol = TOLERANCE[kernel] ?? 2e-4;
          let mismatches = 0, onFrames = 0, maxDp = 0;
          for (let i = 0; i < refFrames.length; i++) {
            const f = frames[i], r = refFrames[i];
            if (f.time !== r.t || f.emitTime !== r.emit) mismatches++;
            for (let k = 0; k < 88; k++) maxDp = Math.max(maxDp, Math.abs(f.probs[k] - r.probs[k]));
            const keys = f.notes.map((n) => n.midi);
            if (keys.join() !== refKeys[i].join()) mismatches++;
            onFrames += keys.length > 0;
          }
          expect(mismatches).toBe(0);
          expect(maxDp).toBeLessThanOrEqual(tol);
          expect(onFrames).toBeGreaterThan(refFrames.length / 2); // the fixtures are busy: a silent decode would pass vacuously
          // the frame clock: one frame per 256 samples at 22.05 kHz
          for (let i = 1; i < frames.length; i++) expect(Math.abs(frames[i].time - frames[i - 1].time - 256 / 22050)).toBeLessThan(1e-9);
        }, 120_000);
      }
    }
  });
}
