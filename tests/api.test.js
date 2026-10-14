// analyze() inputs and rates, the decoder, the resampler and kernel selection.
import { describe, expect, spyOn, test } from 'bun:test';
import * as P from '../pitchplease.js';
import { createTracker } from '../engine/tracker.js';
import { createResampler } from '../engine/resample.js';
import { CHOICES, RELAXED_SIMD_PROBE, SIMD_PROBE, kernelSupported, pickKernel } from '../engine/kernels.js';
import { resolveKernel } from '../engine/kernel-load.js';
import { modelUrl } from '../engine/models.js';
import { readWav } from './helpers/wav.js';

const { samples: CHORD } = readWav(new URL('./fixtures/chord-a-major.wav', import.meta.url).pathname);
const modalChord = (frames) => {
  const c = new Map();
  for (const f of frames) if (f.chord) c.set(f.chord.full, (c.get(f.chord.full) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const resample = (x, from, to) => { const r = createResampler(from, to); return Float32Array.from([...r.push(x), ...r.push(new Float32Array(Math.ceil(from * 0.01)))]); };

describe('analyze()', () => {
  test('every model names the A major chord in the fixture', async () => {
    for (const m of P.models) expect([m.id, modalChord(await P.analyze(CHORD, 48000, { model: m.id }))]).toEqual([m.id, 'A']);
  }, 120_000);

  test('frames carry notes with names, pitch classes and probabilities', async () => {
    const frames = await P.analyze(CHORD, 48000);
    const f = frames.find((x) => x.time > 0.5 && x.notes.length >= 4); // C# and the upper notes enter at 0.21 s
    for (const n of f.notes) {
      expect(n.name).toBe(P.midiToNote(n.midi, true));
      expect(n.pitchClass).toBe(n.midi % 12);
      expect(n.prob).toBeGreaterThan(0.42);
      expect(f.probs[n.midi - 21]).toBe(n.prob);
    }
    expect(f.pitchClasses).toEqual([1, 4, 9]); // C#, E, A
    const names = new Set(frames.flatMap((x) => x.notes.map((n) => n.name)));
    for (const n of ['E2', 'A2', 'C#3', 'E3']) expect(names.has(n)).toBe(true);
  }, 60_000);

  test('other sample rates are resampled (44.1 kHz, 16 kHz) or taken directly (22.05 kHz)', async () => {
    for (const rate of [44100, 22050, 16000]) {
      const x = resample(CHORD, 48000, rate);
      const frames = await P.analyze(x, rate);
      expect([rate, modalChord(frames)]).toEqual([rate, 'A']);
      expect(Math.abs(frames.length - (x.length / rate) * 22050 / 256)).toBeLessThan(2);
    }
  }, 60_000);

  test('an AudioBuffer (stereo, mixed down) works like samples', async () => {
    const buf = { sampleRate: 48000, numberOfChannels: 2, length: CHORD.length, getChannelData: () => CHORD };
    const a = await P.analyze(buf, { model: 'fast' }), b = await P.analyze(CHORD, 48000, { model: 'fast' });
    expect(a.map((f) => f.notes)).toEqual(b.map((f) => f.notes));
  }, 60_000);

  test('a threshold override changes the decode; only on given -> off = 0.6 on', async () => {
    const strict = await P.analyze(CHORD, 48000, { threshold: { on: 0.95 } });
    const loose = await P.analyze(CHORD, 48000, { threshold: { on: 0.3, off: 0.2 } });
    const count = (fr) => fr.reduce((s, f) => s + f.notes.length, 0);
    expect(count(strict)).toBeLessThan(count(loose));
  }, 60_000);

  test('bad input is rejected with a coded error', async () => {
    const code = (p) => p.then(() => 'resolved', (e) => e.code);
    expect(await code(P.analyze('nope', 48000))).toBe('bad-input');
    expect(await code(P.analyze(CHORD, 0))).toBe('bad-input');
    expect(await code(P.analyze(CHORD, 48000, { model: 'loud' }))).toBe('unknown-model');
    expect(await code(P.analyze(CHORD, 48000, { modelBaseUrl: 'file:///nonexistent-pp/' }))).toBe('model-load-failed');
    expect(await code(P.analyze(new DataView(new ArrayBuffer(8)), 48000))).toBe('bad-input');
    expect(await code(P.analyze(new ArrayBuffer(8), 48000))).toBe('bad-input');
  });

  test('any array-like of numbers is accepted', async () => {
    const like = { length: 4800 };
    for (let i = 0; i < 4800; i++) like[i] = Math.sin(i / 10);
    expect((await P.analyze(like, 48000)).length).toBeGreaterThan(5);
    expect((await P.analyze(Array.from(like), 48000)).length).toBeGreaterThan(5);
  });

  test('an unexpected failure is still a PitchPleaseError: internal-error, with the cause', async () => {
    const boom = new Error('boom');
    const e = await P.analyze({ getChannelData() { throw boom; }, numberOfChannels: 1, sampleRate: 48000, length: 10 }).catch((x) => x);
    expect(e).toBeInstanceOf(P.PitchPleaseError);
    expect(e.code).toBe('internal-error');
    expect(e.cause).toBe(boom);
  });

  test("the 'fft' model yields to the event loop on long input", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const frames = await P.analyze(new Float32Array(48000 * 4), 48000, { model: 'fft' });
    clearInterval(timer);
    expect(frames.length).toBe(240); // 60 analysis frames per second of audio
    expect(ticks).toBeGreaterThan(0);
  }, 60_000);
});

describe('options are checked up front', () => {
  const thrown = (fn) => { try { fn(); return 'ok'; } catch (e) { return `${e.code}: ${e.message}`; } };
  test('fft sizes', () => {
    expect(thrown(() => P.create({ fftSize: 1000 }))).toMatch(/^bad-options: fftSize must be a power of two/);
    expect(thrown(() => P.create({ fftSize: 65536 }))).toMatch(/^bad-options/);
    expect(thrown(() => P.create({ binCount: 0 }))).toMatch(/^bad-options: binCount/);
    expect(thrown(() => P.create({ fftSize: 1024, binCount: 513 }))).toMatch(/^bad-options: binCount must be .* \(512\)/);
    expect(thrown(() => P.create({ model: 'fft', fftSize: 1024 }))).toBe('ok'); // binCount defaults within range
  });

  test('a threshold is checked against the selected model (setModel() checks the one it switches to)', async () => {
    expect(thrown(() => P.create({ threshold: { off: 0.65 } }))).toBe('ok'); // fast: on 0.7
    expect(thrown(() => P.create({ model: 'piano', threshold: { off: 0.65 } }))).toMatch(/^bad-threshold: .*for 'piano': on 0.6, off 0.65.*Give `on` as well/);
    expect(thrown(() => P.create({ threshold: { on: 0.8, off: 0.65 } }))).toBe('ok');
    expect(thrown(() => P.create({ threshold: 0.5 }))).toMatch(/^bad-threshold: threshold must be an object/);
    expect((await P.analyze(CHORD.subarray(0, 4800), 48000, { threshold: { off: 0.65 } })).length).toBeGreaterThan(5);
    expect(await P.analyze(CHORD.subarray(0, 4800), 48000, { model: 'piano', threshold: { off: 0.65 } }).catch((e) => e.code)).toBe('bad-threshold');
  });

  test('kernel: null means auto', async () => {
    expect(thrown(() => P.create({ kernel: null }))).toBe('ok');
    expect((await P.analyze(CHORD.subarray(0, 4800), 48000, { kernel: null })).length).toBeGreaterThan(5);
  });

  test('modelBaseUrl: a folder, with or without a slash, keeping a query; a bad one fails at create()', () => {
    expect(modelUrl('fast', 'https://cdn.example/models').href).toBe('https://cdn.example/models/fast.bin');
    expect(modelUrl('fast', 'https://cdn.example/models/').href).toBe('https://cdn.example/models/fast.bin');
    expect(modelUrl('voice', 'https://cdn.example/models?v=3').href).toBe('https://cdn.example/models/voice.bin?v=3');
    expect(modelUrl('piano', new URL('file:///srv/pp/')).href).toBe('file:///srv/pp/piano.bin');
    expect(thrown(() => P.create({ modelBaseUrl: 'models/' }))).toMatch(/^bad-options: modelBaseUrl 'models\/' is not a URL here: outside a browser it must be absolute/);
    expect(thrown(() => P.create({ modelBaseUrl: '' }))).toMatch(/^bad-options/);
  });
});

describe('decoder (per-key hysteresis)', () => {
  test('on above `on`, off below `off`, strict inequalities', () => {
    const t = createTracker({ on: 0.7, off: 0.42 });
    const seq = [0.5, 0.71, 0.5, 0.43, 0.42, 0.69, 0.7, 0.701];
    const out = seq.map((p, i) => { const probs = new Float32Array(88); probs[39] = p; return t.step(probs, i * 0.0116).notes.map((n) => n.name); });
    expect(out).toEqual([[], ['C4'], ['C4'], ['C4'], [], [], [], ['C4']]);
  });

  test('chords are named from the on keys and held through silence for clearAfterMs', () => {
    const t = createTracker({ on: 0.5, off: 0.3, clearAfterMs: 200 });
    const frame = (keys) => { const p = new Float32Array(88); for (const m of keys) p[m - 21] = 0.9; return p; };
    expect(t.step(frame([57, 61, 64]), 0).event).toBe('chord'); // A C# E
    expect(t.chord.full).toBe('A');
    expect(t.step(frame([]), 0.1).event).toBeNull();
    expect(t.step(frame([]), 0.29).event).toBeNull();
    expect(t.step(frame([]), 0.31).event).toBe('clear');
  });

  test('stabilityFrames delays naming until the set holds', () => {
    const t = createTracker({ on: 0.5, off: 0.3, stabilityFrames: 3 });
    const p = new Float32Array(88); for (const m of [60, 64, 67]) p[m - 21] = 0.9;
    expect([t.step(p, 0).event, t.step(p, 0.01).event, t.step(p, 0.02).event]).toEqual([null, null, 'chord']);
  });
});

describe('resampler', () => {
  const sine = (f, rate, n) => Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f * i / rate));
  test('keeps a tone\'s frequency and level, passes DC at unity', () => {
    for (const [from, to] of [[44100, 22050], [16000, 22050], [96000, 22050], [32000, 22050]]) {
      const y = resample(sine(440, from, from), from, to).subarray(1000, 20000);
      let best = 0, bestF = 0;
      for (let f = 430; f <= 450; f += 1) { // project onto test tones
        let c = 0, s = 0; for (let i = 0; i < y.length; i++) { c += y[i] * Math.cos(2 * Math.PI * f * i / to); s += y[i] * Math.sin(2 * Math.PI * f * i / to); }
        const a = 2 * Math.hypot(c, s) / y.length; if (a > best) { best = a; bestF = f; }
      }
      expect([from, bestF]).toEqual([from, 440]);
      expect(Math.abs(best - 1)).toBeLessThan(0.02);
      const dc = resample(new Float32Array(from).fill(0.5), from, to).subarray(2000, 10000);
      for (const v of dc) expect(Math.abs(v - 0.5)).toBeLessThan(1e-6);
    }
  });
  test('output does not depend on how the input is chunked', () => {
    const x = sine(1000, 44100, 30000), a = createResampler(44100, 22050), b = createResampler(44100, 22050);
    const ya = a.push(x), yb = [];
    for (let i = 0; i < x.length; i += 97) yb.push(...b.push(x.subarray(i, i + 97)));
    expect(yb.length).toBe(ya.length);
    for (let i = 0; i < ya.length; i++) expect(yb[i]).toBe(ya[i]);
  });
});

describe('kernel selection (the WASM seam)', () => {
  const JS = { id: 'js', impl: 'js' };
  test('feature probes validate here; a corrupted probe does not', () => {
    expect(WebAssembly.validate(SIMD_PROBE)).toBe(true);
    expect(WebAssembly.validate(RELAXED_SIMD_PROBE)).toBe(true);
    const bad = Uint8Array.from(SIMD_PROBE); bad[bad.length - 2] = 0xff; // i8x16.popcnt -> an unknown SIMD opcode
    expect(WebAssembly.validate(bad)).toBe(false);
    expect(kernelSupported({ probe: bad })).toBe(false);
  });

  test("'auto' picks the first supported choice; the JS kernel is the floor", () => {
    expect(pickKernel()).toBe(CHOICES.find(kernelSupported));
    expect(CHOICES.at(-1)).toMatchObject({ id: 'js', impl: 'js' }); // needs no WebAssembly at all
    const bad = Uint8Array.from(SIMD_PROBE); bad[bad.length - 2] = 0xff;
    const choices = [{ id: 'wasm-new', impl: 'wasm', probe: bad }, { id: 'wasm-simd', impl: 'js', probe: SIMD_PROBE }, ...CHOICES];
    expect(pickKernel('auto', choices).id).toBe('wasm-simd');
    expect(pickKernel('auto', [choices[0], JS]).id).toBe('js');
    expect(() => pickKernel('wasm-new', choices)).toThrow(/needs a WebAssembly feature/);
  });

  test("a kernel whose .wasm fails to load falls back under 'auto' (with a warning), fails when named", async () => {
    const broken = { id: 'wasm-broken', impl: 'js', probe: SIMD_PROBE, wasm: () => new URL('file:///nonexistent-pp/incport.wasm') };
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const r = await resolveKernel('auto', 'bytes', [broken, JS]);
    expect(r.choice.id).toBe('js');
    expect(warn.mock.calls[0][0]).toMatch(/Could not load the 'wasm-broken' kernel.*Falling back to the 'js' kernel/);
    warn.mockRestore();
    const e = await resolveKernel('wasm-broken', 'bytes', [broken, JS]).catch((x) => x);
    expect(e.code).toBe('kernel-load-failed');
  });

  test('a WASM choice hands its bytes to the worklet and a compiled module to the main thread', async () => {
    // A stand-in .wasm (the simd probe module) proves the plumbing; the real kernel arrives with incport-wasm.js.
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(`${(await import('node:os')).tmpdir()}/pp-wasm-`);
    writeFileSync(`${dir}/k.wasm`, SIMD_PROBE);
    const choice = { id: 'wasm-test', impl: 'js', probe: SIMD_PROBE, wasm: () => new URL(`file://${dir}/k.wasm`) };
    const bytes = await resolveKernel('wasm-test', 'bytes', [choice]);
    expect(bytes.wasm).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(bytes.wasm)).toEqual(SIMD_PROBE);
    const mod = await resolveKernel('wasm-test', 'module', [choice]);
    expect(mod.wasm).toBeInstanceOf(WebAssembly.Module);
  });

  test('a .wasm that downloads but does not compile is kernel-load-failed when named, and falls back under auto', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(`${(await import('node:os')).tmpdir()}/pp-wasm-bad-`);
    writeFileSync(`${dir}/k.wasm`, new Uint8Array([0, 0x61, 0x73, 0x6d, 9, 9, 9, 9])); // bad version: compile throws
    const choice = { id: 'wasm-garbled', impl: 'js', probe: SIMD_PROBE, wasm: () => new URL(`file://${dir}/k.wasm`) };
    const e = await resolveKernel('wasm-garbled', 'module', [choice, JS]).catch((x) => x);
    expect(e.code).toBe('kernel-load-failed');
    expect(e.cause).toBeInstanceOf(WebAssembly.CompileError);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const r = await resolveKernel('auto', 'module', [choice, JS]);
    expect(r.choice.id).toBe('js');
    warn.mockRestore();
  });
});
