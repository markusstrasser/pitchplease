// analyze() inputs and rates, the decoder, the resampler and kernel selection.
import { describe, expect, spyOn, test } from 'bun:test';
import * as P from '../pitchplease.js';
import { createTracker } from '../engine/tracker.js';
import { createResampler } from '../engine/resample.js';
import { CHOICES, RELAXED_SIMD_PROBE, SIMD_PROBE, kernelSupported, pickKernel } from '../engine/kernels.js';
import { resolveKernel } from '../engine/kernel-load.js';
import { modelUrl } from '../engine/models.js';
import { readWav } from './helpers/wav.js';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { packModel, unpackModel } from '../engine/models.js';
import { installBrowser, settle } from './helpers/browser.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const copyAssets = () => {
  const dir = mkdtempSync(`${tmpdir()}/pp-assets-`);
  for (const name of ['engine', 'models']) cpSync(new URL(`../${name}`, import.meta.url), `${dir}/${name}`, { recursive: true });
  return { dir, base: pathToFileURL(dir + '/') };
};
const wrongRevision = (file) => {
  const b = readFileSync(file);
  const { header, weights } = unpackModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  writeFileSync(file, packModel({ ...header, revision: '000000000000' }, new Float32Array(weights)));
};

describe('self-hosted assets', () => {
  test('analyze loads models from assetBaseUrl; modelBaseUrl takes precedence', async () => {
    const { dir, base } = copyAssets();
    wrongRevision(`${dir}/models/fast.bin`);
    const e = await P.analyze(new Float32Array(4800), 48000, { assetBaseUrl: base, kernel: 'js' }).catch(e => e);
    expect(e.code).toBe('model-load-failed');
    expect(e.message).toContain(new URL('models/fast.bin', base).href);
    expect(e.message).toMatch(/holds weights revision 000000000000/);
    expect(e.message).toContain(P.models[0].revision);
    const nodeError = JSON.parse(execFileSync('node', ['--input-type=module', '-e',
      `import { analyze } from ${JSON.stringify(new URL('../pitchplease.js', import.meta.url).href)};
       try { await analyze(new Float32Array(0), 48000, { assetBaseUrl: ${JSON.stringify(base.href)}, kernel: 'js' }); }
       catch(e) { console.log(JSON.stringify({ code: e.code, message: e.message })); }`], { encoding: 'utf8' }));
    expect(nodeError).toEqual({ code: e.code, message: e.message });
    expect((await P.analyze(new Float32Array(4800), 48000, {
      assetBaseUrl: base, modelBaseUrl: new URL('../models/', import.meta.url), kernel: 'js',
    })).length).toBeGreaterThan(0);
  }, 30_000);

  test('relative asset bases in Node fail as bad-options', async () => {
    const e = await P.analyze(new Float32Array(0), 48000, { assetBaseUrl: './assets/' }).catch(e => e);
    expect(e.code).toBe('bad-options');
    expect(e.message).toMatch(/assetBaseUrl.*must be absolute/);
    expect(() => P.create({ assetBaseUrl: '' })).toThrow(/assetBaseUrl/);
    for (const assetBaseUrl of ['data:text/plain,assets', 'mailto:assets@example.com', 123, {}]) {
      const e = await P.analyze(new Float32Array(0), 48000, { assetBaseUrl }).catch(e => e);
      expect(e.code).toBe('bad-options');
    }
  });

  test('tampered WASM fails explicitly; auto warns and falls back to JS', async () => {
    await resolveKernel('wasm-simd', 'module'); // a good cached default must not hide a bad relocated copy
    const { dir, base } = copyAssets();
    for (const name of ['incport.wasm', 'incport-relaxed.wasm']) {
      const file = `${dir}/engine/${name}`, bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(file, bytes);
    }
    const e = await P.analyze(new Float32Array(4800), 48000, { assetBaseUrl: base, kernel: 'wasm-simd' }).catch(e => e);
    expect(e.code).toBe('kernel-load-failed');
    expect(e.message).toMatch(/SHA-256 mismatch/);
    expect(e.message).toContain(new URL('engine/incport.wasm', base).href);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const frames = await P.analyze(new Float32Array(4800), 48000, { assetBaseUrl: base });
      expect(frames).toEqual(await P.analyze(new Float32Array(4800), 48000, { kernel: 'js' }));
      expect(warn.mock.calls.flat().join(' ')).toMatch(/SHA-256 mismatch.*Falling back/);
      expect(warn.mock.calls.flat().join(' ')).toContain("'js' kernel");
    } finally { warn.mockRestore(); }
  }, 30_000);

  test('kernel byte and module caches distinguish resolved URLs', async () => {
    const a = copyAssets(), b = copyAssets();
    const first = await resolveKernel('wasm-simd', 'bytes', undefined, a.base);
    const second = await resolveKernel('wasm-simd', 'bytes', undefined, b.base);
    expect(first.wasm).not.toBe(second.wasm);
    expect(new Uint8Array(first.wasm)).toEqual(new Uint8Array(second.wasm));
    expect((await resolveKernel('wasm-simd', 'bytes', undefined, a.base)).wasm).toBe(first.wasm);
    const am = await resolveKernel('wasm-simd', 'module', undefined, a.base);
    const bm = await resolveKernel('wasm-simd', 'module', undefined, b.base);
    expect(am.wasm).not.toBe(bm.wasm);
    expect((await resolveKernel('wasm-simd', 'module', undefined, a.base)).wasm).toBe(am.wasm);
  });

  test('without crypto.subtle a relocated kernel loads without an integrity warning', async () => {
    const { dir, base } = copyAssets();
    const file = `${dir}/engine/incport.wasm`, bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
      const loaded = await resolveKernel('wasm-simd', 'bytes', undefined, base);
      expect(new Uint8Array(loaded.wasm)).toEqual(new Uint8Array(bytes));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (saved) Object.defineProperty(globalThis, 'crypto', saved); else delete globalThis.crypto;
    }
  });

  test('a version mismatch delivered after startup stops the suspended session', async () => {
    const browser = installBrowser({ startSuspended: true, resumeDelayMs: Infinity });
    const Original = globalThis.AudioWorkletNode;
    let timer;
    globalThis.AudioWorkletNode = class extends Original {
      constructor(...args) {
        super(...args);
        const port = this.port;
        this.port = {
          postMessage: port.postMessage.bind(port),
          set onmessage(fn) {
            port.onmessage = fn && (e => {
              if (e.data.type === 'ready') timer = setTimeout(() => fn({ data: { ...e.data, version: '0.0.0' } }), 2200);
              else fn(e);
            });
          },
        };
      }
    };
    let received, errorDeadline;
    const error = new Promise(resolve => { received = resolve; });
    const d = P.create({ kernel: 'js', onError: received });
    try {
      expect(await d.start()).toBe(true);
      const reported = await Promise.race([error, new Promise(resolve => { errorDeadline = setTimeout(resolve, 3000); })]);
      expect(reported?.code).toBe('worklet-load-failed');
      expect(d.running).toBe(false);
      expect(browser.state.closed).toBe(1);
      expect(browser.state.stoppedTracks).toBe(1);
    } finally { clearTimeout(timer); clearTimeout(errorDeadline); d.stop(); browser.restore(); }
  }, 10_000);

  test('asset folders resolve relative to a browser page and preserve queries', () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://app.example/page/index.html' } });
    try {
      expect(modelUrl('fast', undefined, '../assets?v=31').href).toBe('https://app.example/assets/models/fast.bin?v=31');
      expect(modelUrl('fast', 'https://models.example/other?x=1', '../assets?v=31').href).toBe('https://models.example/other/fast.bin?x=1');
      expect(() => P.create({ assetBaseUrl: '../assets?v=31' })).not.toThrow();
    } finally {
      if (old) Object.defineProperty(globalThis, 'location', old); else delete globalThis.location;
    }
  });

  test('a different revision at modelBaseUrl is refused', async () => {
    const { dir, base } = copyAssets();
    wrongRevision(`${dir}/models/fast.bin`);
    const e = await P.analyze(new Float32Array(0), 48000, { modelBaseUrl: new URL('models/', base), kernel: 'js' }).catch(e => e);
    expect(e.code).toBe('model-load-failed');
    expect(e.message).toMatch(/holds weights revision 000000000000/);
  });

  test('a mismatched worklet version fails with both versions and its URL', async () => {
    const browser = installBrowser();
    const Original = globalThis.AudioWorkletNode;
    globalThis.AudioWorkletNode = class extends Original {
      constructor(...args) {
        super(...args);
        const port = this.port;
        this.port = {
          postMessage: port.postMessage.bind(port),
          set onmessage(fn) { port.onmessage = fn && (e => fn({ data: { ...e.data, version: '0.0.0' } })); },
        };
      }
    };
    const d = P.create({ kernel: 'js' });
    try {
      const e = await d.start().catch(e => e);
      expect(e.code).toBe('worklet-load-failed');
      expect(e.message).toContain('0.0.0');
      expect(e.message).toContain(P.version);
      expect(e.message).toContain(new URL('../engine/worklet.js', import.meta.url).href);
      expect(e.message).toMatch(/copy engine\/ and models\/ from one release/i);
      expect(d.running).toBe(false);
    } finally { d.stop(); browser.restore(); }
  });

  for (const reportedVersion of ['0.0.0', undefined]) {
    test(`a worklet reporting version ${reportedVersion} fails before ready as a version mismatch`, async () => {
      const browser = installBrowser();
      const Original = globalThis.AudioWorkletNode;
      const messages = [];
      globalThis.AudioWorkletNode = class extends Original {
        constructor(ctx, name, options) {
          super(ctx, name, { ...options, processorOptions: { ...options.processorOptions, impl: 'missing' } });
          const port = this.port;
          this.port = {
            postMessage: port.postMessage.bind(port),
            set onmessage(fn) {
              port.onmessage = fn && (e => {
                messages.push(e.data);
                const data = { ...e.data, version: reportedVersion };
                if (reportedVersion === undefined) delete data.version; // a 3.0.0 worklet has no version
                fn({ data });
              });
            },
          };
        }
      };
      const d = P.create({ kernel: 'js' });
      try {
        const error = await d.start().catch(e => e);
        expect(messages.map(msg => msg.type)).toEqual(['error']);
        expect(error.code).toBe('worklet-load-failed');
        expect(error.message).toContain(String(reportedVersion));
        expect(error.message).toContain(P.version);
        expect(error.message).toContain(new URL('../engine/worklet.js', import.meta.url).href);
        expect(error.message).toMatch(/copy engine\/ and models\/ from one release/i);
        expect(d.running).toBe(false);
        expect(browser.state.closed).toBe(1);
        expect(browser.state.stoppedTracks).toBe(1);
      } finally { d.stop(); browser.restore(); }
    });
  }

  test('a same-version worklet initialization error includes its version and remains processor-error', async () => {
    const browser = installBrowser();
    const Original = globalThis.AudioWorkletNode;
    const messages = [];
    globalThis.AudioWorkletNode = class extends Original {
      constructor(ctx, name, options) {
        super(ctx, name, { ...options, processorOptions: { ...options.processorOptions, impl: 'missing' } });
        const port = this.port;
        this.port = {
          postMessage: port.postMessage.bind(port),
          set onmessage(fn) { port.onmessage = fn && (e => { messages.push(e.data); fn(e); }); },
        };
      }
    };
    const d = P.create({ kernel: 'js' });
    try {
      const error = await d.start().catch(e => e);
      expect(messages).toEqual([{ type: 'error', version: P.version, message: "kernel 'missing' is not in this worklet build" }]);
      expect(error.code).toBe('processor-error');
      expect(d.running).toBe(false);
    } finally { d.stop(); browser.restore(); }
  });

  test('a same-version worklet processing error includes its version and stops detection', async () => {
    const browser = installBrowser();
    const errors = [], messages = [];
    const d = P.create({ kernel: 'js', onError: e => errors.push(e) });
    try {
      expect(await d.start()).toBe(true);
      const node = browser.state.nodes[0], handle = node.port.onmessage;
      node.port.onmessage = e => { messages.push(e.data); handle(e); };
      node.processor.det.push = () => { throw new Error('processing failed'); };
      browser.ctx.render(new Float32Array(browser.ctx.renderSize));
      await settle();
      expect(messages).toEqual([{ type: 'error', version: P.version, message: 'processing failed' }]);
      expect(errors.map(e => e.code)).toEqual(['processor-error']);
      expect(d.running).toBe(false);
    } finally { d.stop(); browser.restore(); }
  });

  test('create relocates the worklet and keeps the base query', async () => {
    const { base } = copyAssets();
    base.search = '?release=31';
    const browser = installBrowser();
    const Original = globalThis.AudioContext;
    const urls = [];
    globalThis.AudioContext = class extends Original {
      constructor(...args) {
        super(...args);
        const addModule = this.audioWorklet.addModule;
        this.audioWorklet.addModule = url => { urls.push(String(url)); return addModule(url); };
      }
    };
    const d = P.create({ assetBaseUrl: base, kernel: 'js' });
    try {
      expect(await d.start()).toBe(true);
      expect(urls).toEqual([new URL('engine/worklet.js?release=31', base).href]);
      expect(await d.setModel('piano')).toBe('piano');
    } finally { d.stop(); browser.restore(); }
  });
});

const { samples: CHORD } = readWav(new URL('./fixtures/chord-a-major.wav', import.meta.url).pathname);
const modalChord = (frames) => {
  const c = new Map();
  for (const f of frames) if (f.chord) c.set(f.chord.full, (c.get(f.chord.full) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const resample = (x, from, to) => { const r = createResampler(from, to); return Float32Array.from([...r.push(x), ...r.push(new Float32Array(Math.ceil(from * 0.01)))]); };

describe('analyze()', () => {
  test('every frame retains the 3.0.0 notes after rebuilding model headers', async () => {
    const hashes = {
      fast: '0133f6f2579c1145fbc0958401cfc1ea57202d39281fc02efb76a71232e035af',
      piano: 'd4d1032c8798a67a1bc580b2ccf7f7503f64a204a713a1c7836736db26451ac1',
      voice: 'ee43f21ac385e1c0a59a7dd8730fa341e7107d8b9b2bf191fc5138caf77c71f9',
    };
    for (const [model, hash] of Object.entries(hashes)) {
      const frames = await P.analyze(CHORD, 48000, { model, kernel: 'wasm-simd' });
      expect(frames.length).toBe(172);
      expect(createHash('sha256').update(JSON.stringify(frames.map(f => f.notes))).digest('hex')).toBe(hash);
    }
  }, 60_000);

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
