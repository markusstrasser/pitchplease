// The live detector, end to end on the main thread, against a scripted browser (tests/helpers/browser.js) whose
// AudioWorklet runs the real generated engine/worklet.js. The real-browser run is tests/ui/run.mjs.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as P from '../pitchplease.js';
import { packModel } from '../engine/models.js';
import { pickKernel } from '../engine/kernels.js';
import { installBrowser, settle } from './helpers/browser.js';
import { readWav } from './helpers/wav.js';

const fixture = (name) => readWav(new URL(`./fixtures/${name}.wav`, import.meta.url).pathname).samples;
const CHORD = fixture('chord-a-major'), PIANO = fixture('piano-maestro');
const KERNEL = pickKernel().id; // what 'auto' runs here

async function until(cond, ms = 10_000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await settle(5); }
}

let env;
beforeEach(() => { env = installBrowser(); });
afterEach(() => env.restore());

describe('trained models in the (scripted) AudioWorklet', () => {
  test('continuous session time: trained swaps keep both clocks increasing within two hops, excluding pauses', async () => {
    const frames = [];
    const d = P.create({ onNotes: (n, f) => frames.push(f) });
    await d.start();
    env.ctx.render(CHORD.subarray(0, 12000));
    await settle();
    const hop = 256 / 22050;
    for (const model of ['piano', 'voice', 'fast']) {
      const before = frames.at(-1), count = frames.length;
      if (model === 'voice') await d.setModel('fast'); // supersede a warming candidate without losing old output
      await d.setModel(model);
      // Batch rendering deliberately delays main-thread messages: offsets cannot use delivery time.
      env.ctx.render(CHORD.subarray(0, 6000));
      await settle();
      const first = frames[count];
      expect(first.time).toBeGreaterThan(before.time);
      expect(first.emitTime).toBeGreaterThan(before.emitTime);
      for (let i = count; i < frames.length; i++) {
        expect(frames[i].time - frames[i - 1].time).toBeGreaterThan(0);
        expect(frames[i].time - frames[i - 1].time).toBeLessThanOrEqual(2 * hop + 1e-9);
        expect(frames[i].emitTime - frames[i - 1].emitTime).toBeGreaterThan(0);
        expect(frames[i].emitTime - frames[i - 1].emitTime).toBeLessThanOrEqual(2 * hop + 1e-9);
      }
    }
    const beforePause = frames.at(-1), count = frames.length;
    d.togglePause();
    await settle();
    env.ctx.render(new Float32Array(48000 * 4));
    await d.setModel('piano'); // swap while paused, before the new node's first quantum
    await settle();
    expect(frames.length).toBe(count);
    d.togglePause();
    await settle();
    env.ctx.render(CHORD.subarray(0, 6000));
    await settle();
    expect(frames[count].time - beforePause.time).toBeGreaterThan(0);
    expect(frames[count].time - beforePause.time).toBeLessThanOrEqual(2 * hop + 1e-9);
    expect(frames.at(-1).emitTime - beforePause.emitTime).toBeCloseTo(0.125, 1);
    d.stop();
  }, 60_000);

  test('continuous session time: a newer port cannot choose the origin before the original frame arrives', async () => {
    const frames = [];
    const d = P.create({ onNotes: (n, f) => frames.push(f) });
    await d.start();
    env.ctx.render(new Float32Array(512)); // original input began, but it has not emitted yet
    await settle();
    await d.setModel('piano');
    const nodes = env.state.nodes, handlers = nodes.map(n => n.port.onmessage), queued = nodes.map(() => []);
    nodes.forEach((n, i) => { n.port.onmessage = e => queued[i].push(e); });
    env.ctx.render(new Float32Array(6000));
    await settle();
    const nextFrames = queued[1].filter(e => e.data.type === 'frame');
    handlers[1](nextFrames[0]); // force the newer port to win the race
    for (const e of queued[0]) handlers[0]?.(e);
    for (const e of queued[1]) if (e !== nextFrames[0]) handlers[1](e);
    expect(frames[0].time).toBeGreaterThanOrEqual(0);
    expect(frames.at(-1).emitTime).toBeCloseTo(nextFrames.at(-1).data.startedAt + nextFrames.at(-1).data.emit, 9);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].time).toBeGreaterThan(frames[i - 1].time);
      expect(frames[i].emitTime).toBeGreaterThan(frames[i - 1].emitTime);
    }
    d.stop();
  }, 60_000);

  test('continuous session time: stats describe the engine producing warm-up frames', async () => {
    const updates = [];
    const d = P.create({ onUpdate: data => updates.push([data.model, d.stats.model]) });
    await d.start();
    env.ctx.render(new Float32Array(4800));
    await settle();
    await d.setModel('piano');
    expect(d.stats.model).toBe('fast'); // ready, but no new audio has been processed yet
    env.ctx.render(new Float32Array(4800));
    await settle();
    expect(d.stats.model).toBe('piano');
    expect(updates.some(([model]) => model === 'fast')).toBe(true);
    expect(updates.some(([model]) => model === 'piano')).toBe(true);
    expect(updates.every(([model, stats]) => model === stats)).toBe(true);
    d.stop();
  });

  test('continuous session time: FFT swaps retain session clocks and restart resets them', async () => {
    const frames = [];
    const d = P.create({ model: 'fft', onNotes: (n, f) => frames.push(f) });
    await d.start();
    env.tick(1000);
    const before = frames.at(-1), count = frames.length;
    await d.setModel('fast');
    env.ctx.render(CHORD.subarray(0, 6000));
    await settle();
    expect(frames[count].time).toBeGreaterThan(before.time);
    expect(frames[count].emitTime).toBeGreaterThan(before.emitTime);
    const trained = frames.at(-1);
    await d.setModel('fft');
    env.tick(env.state.clock + 16);
    expect(frames.at(-1).time).toBeGreaterThan(trained.time);
    expect(frames.at(-1).emitTime).toBeGreaterThan(trained.emitTime);
    d.stop();
    await d.start();
    expect(frames.at(-1).time).toBe(0);
    d.stop();
  }, 30_000);

  test('live frames decode exactly like analyze() on the same audio', async () => {
    const frames = [];
    const d = P.create({ onNotes: (notes, f) => frames.push(f) });
    await d.start();
    expect(d.running).toBe(true);
    expect(env.ctx.sampleRate).toBe(48000);
    expect(env.ctx.renderSize).toBe(512); // renderSizeHint: 512 was requested
    env.ctx.render(PIANO);
    const offline = await P.analyze(PIANO, 48000);
    await until(() => frames.length >= offline.length - 3); // live has no end-of-input flush
    expect(d.stats).toMatchObject({ model: 'fast', kernel: KERNEL, sampleRate: 48000 });
    d.stop();
    expect(d.stats).toMatchObject({ model: 'fast', kernel: null, sampleRate: 0 });
    expect(frames.length).toBeGreaterThan(300);
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].time).toBe(offline[i].time);
      expect(frames[i].notes).toEqual(offline[i].notes);
      expect(frames[i].chord).toEqual(offline[i].chord);
    }
  }, 60_000);

  test('callbacks: notes, chord, v2 onUpdate payload, stats', async () => {
    const chords = [], updates = [];
    let notesCalls = 0;
    const d = P.create({ onNotes: () => notesCalls++, onChord: (c) => chords.push(c.full), onUpdate: (u) => updates.push(u) });
    await d.start();
    env.ctx.render(CHORD);
    await until(() => notesCalls > 150 && chords.length > 0);
    expect(chords[0]).toBe('A');
    const u = updates.find((x) => x.fundCount >= 3);
    expect(u.model).toBe('fast');
    expect(u.spectrum).toBe(u.probs);
    expect(u.spectrum.length).toBe(88);
    expect(Array.from(u.binMidi.subarray(0, 2))).toEqual([21, 22]);
    expect(Array.from(u.fundMidis)).toEqual(u.notes.map((n) => n.midi));
    expect(u.threshold).toBe(0.7);
    expect(u.peakCount).toBe(0);
    expect(d.stats.framesPerSecond).toBeGreaterThan(80); // 48000/557.3 ≈ 86 frames per second of audio
    expect(d.stats.framesPerSecond).toBeLessThan(90);
    d.stop();
  }, 60_000);

  test('setModel swaps engines live without asking for the microphone again', async () => {
    const log = [];
    const d = P.create({ onNotes: (n) => n.length && log.push(['notes', d.stats.model]), onChord: (c) => log.push(['chord', c.full]), onChordEnd: () => log.push(['end']) });
    await d.start();
    env.ctx.render(CHORD.subarray(0, 48000));
    await until(() => log.some((e) => e[0] === 'chord'));
    const firstNode = env.state.nodes[0];

    await d.setModel('piano');
    expect(env.state.micCalls).toBe(1);
    expect(d.model).toBe('piano');
    expect(log.at(-1)).toEqual(['end']); // the held chord ends with its engine
    log.length = 0;
    env.ctx.render(CHORD);
    await until(() => log.some((e) => e[0] === 'chord'));
    expect(env.ctx.sources[0].targets.has(firstNode)).toBe(false); // old node retires after warm-up
    expect(d.stats).toMatchObject({ model: 'piano', kernel: KERNEL });
    expect(log.find((e) => e[0] === 'chord')[1]).toBe('A');
    expect(log.filter((e) => e[0] === 'notes').at(-1)[1]).toBe('piano');

    await d.setModel('fft');
    env.tick(1000); env.tick(1016);
    expect(d.stats).toMatchObject({ model: 'fft', kernel: null });
    expect(env.state.raf.size).toBe(1); // the fft loop keeps scheduling animation frames

    await d.setModel('voice');
    log.length = 0;
    env.ctx.render(CHORD);
    await until(() => log.some((e) => e[0] === 'chord'));
    expect(d.stats).toMatchObject({ model: 'voice', kernel: KERNEL });
    expect(env.state.raf.size).toBe(0); // fft retires when the trained engine first emits
    expect(log.find((e) => e[0] === 'chord')[1]).toBe('A');
    expect(env.state.micCalls).toBe(1);

    d.stop();
    expect(env.state.stoppedTracks).toBe(1);
    expect(env.state.closed).toBe(1);
    expect(d.running).toBe(false);
  }, 60_000);

  test('setModel before start() selects and preloads; start() then runs it', async () => {
    const d = P.create();
    await d.setModel('voice');
    expect(d.model).toBe('voice');
    await d.start();
    expect(d.stats.model).toBe('voice');
    d.stop();
  }, 60_000);

  test('pause stops callbacks, resume restarts them', async () => {
    let n = 0;
    const d = P.create({ onNotes: () => n++ });
    await d.start();
    // the pause message reaches the worklet asynchronously; real audio keeps flowing, this script waits for it
    expect(d.togglePause()).toBe(true);
    expect(d.paused).toBe(true);
    await settle(20);
    env.ctx.render(CHORD.subarray(0, 24000));
    await settle(50);
    expect(n).toBe(0);
    expect(d.togglePause()).toBe(false);
    await settle(20);
    env.ctx.render(CHORD.subarray(0, 24000));
    await until(() => n > 20);
    d.stop();
  }, 60_000);

  test('a MediaStream passed to start() is used as is and not stopped', async () => {
    const stream = new env.MediaStream();
    const d = P.create();
    await d.start(stream);
    expect(env.state.micCalls).toBe(0);
    d.stop();
    expect(env.state.stoppedTracks).toBe(0);
  }, 60_000);
});

describe('errors are actionable and coded', () => {
  const code = async (p) => { try { await p; return 'resolved'; } catch (e) { expect(e).toBeInstanceOf(P.PitchPleaseError); return e.code; } };

  test('invalid options throw at create()', () => {
    expect(() => P.create({ model: 'pian' })).toThrow(/Unknown model 'pian'. Choose one of: fast, piano, voice, fft/);
    expect(() => P.create({ threshold: { on: 0.3, off: 0.5 } })).toThrow(/0 < off <= on < 1/);
    expect(() => P.create({ kernel: 'gpu' })).toThrow(/Unknown kernel 'gpu'/);
    expect(() => P.create({ stabilityFrames: 0 })).toThrow(/stabilityFrames/);
  });

  test('microphone denied: onError gets it, or start() rejects', async () => {
    env.restore(); env = installBrowser({ micError: 'NotAllowedError' });
    const errors = [];
    const d = P.create({ onError: (e) => errors.push(e) });
    await d.start();
    expect(errors.map((e) => e.code)).toEqual(['mic-denied']);
    expect(errors[0].message).toMatch(/Allow it for this site/);
    expect(d.running).toBe(false);
    expect(env.state.closed).toBe(1); // the context opened for the attempt is closed again
    expect(await code(P.create().start())).toBe('mic-denied');
  });

  test('no microphone, busy microphone', async () => {
    env.restore(); env = installBrowser({ micError: 'NotFoundError' });
    expect(await code(P.create().start())).toBe('mic-not-found');
    env.restore(); env = installBrowser({ micError: 'NotReadableError' });
    expect(await code(P.create().start())).toBe('mic-busy');
  });

  test('no AudioWorklet: trained models say so, fft still runs', async () => {
    env.restore(); env = installBrowser({ worklet: false });
    expect(await code(P.create().start())).toBe('worklet-unsupported');
    const d = P.create({ model: 'fft' });
    expect(await code(d.start())).toBe('resolved');
    d.stop();
  });

  test('insecure page', async () => {
    env.restore(); env = installBrowser({ worklet: false });
    globalThis.isSecureContext = false;
    delete globalThis.navigator.mediaDevices;
    const e = await P.create().start().catch((x) => x);
    expect(e.code).toBe('insecure-context');
    expect(e.message).toMatch(/https:\/\/ or from http:\/\/localhost/);
  });

  test('model weights that cannot be fetched', async () => {
    const e = await P.create({ modelBaseUrl: 'file:///nonexistent-pitchplease/' }).start().catch((x) => x);
    expect(e.code).toBe('model-load-failed');
    expect(e.message).toMatch(/'fast' model from file:\/\/\/nonexistent-pitchplease\/fast.bin/);
    expect(e.message).toMatch(/modelBaseUrl/);
  });

  test('a detector that fails inside the worklet reports processor-error', async () => {
    const dir = mkdtempSync(`${tmpdir()}/pp-bad-model-`);
    writeFileSync(`${dir}/fast.bin`, packModel({ model: 'fast', revision: P.models.find(m => m.id === 'fast').revision, tensors: { bn_mul: { offset: 0, shape: [1] } }, const: {} }, new Float32Array(1)));
    const errors = [];
    const d = P.create({ modelBaseUrl: pathToFileURL(dir + '/'), onError: (e) => errors.push(e) });
    await d.start();
    await until(() => errors.length > 0);
    expect(errors[0].code).toBe('processor-error');
    expect(errors[0].message).toMatch(/'fast' detector stopped in the audio thread/);
    d.stop();
  });

  test('setModel with an unknown id', async () => {
    const d = P.create();
    expect(await code(d.setModel('loud'))).toBe('unknown-model');
    expect(d.model).toBe('fast');
  });

  test('start() outside a browser points to analyze()', async () => {
    env.restore(); env = { restore() {} };
    const e = await P.create().start().catch((x) => x);
    expect(e.code).toBe('no-web-audio');
    expect(e.message).toMatch(/analyze\(\)/);
  });
});
