// start(), stop() and setModel() racing each other, failures while starting or switching, and the browser quirks
// around them (suspended contexts, a microphone at another rate). Runs on the scripted browser of
// tests/helpers/browser.js, whose AudioWorklet runs the real generated engine/worklet.js.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as P from '../pitchplease.js';
import { packModel } from '../engine/models.js';
import { CHOICES, SIMD_PROBE } from '../engine/kernels.js';
import { installBrowser, settle } from './helpers/browser.js';
import { readWav } from './helpers/wav.js';

const fixture = (name) => readWav(fileURLToPath(new URL(`./fixtures/${name}.wav`, import.meta.url)));
const CHORD = fixture('chord-a-major').samples;

async function until(cond, ms = 10_000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await settle(5); }
}

// A model folder whose fast.bin is the shipped one and whose piano.bin unpacks but cannot build a detector.
function brokenPianoDir() {
  const dir = mkdtempSync(`${tmpdir()}/pp-broken-piano-`);
  copyFileSync(fileURLToPath(new URL('../models/fast.bin', import.meta.url)), `${dir}/fast.bin`);
  writeFileSync(`${dir}/piano.bin`, packModel({ model: 'piano', tensors: { bn_mul: { offset: 0, shape: [1] } }, const: {} }, new Float32Array(1)));
  return pathToFileURL(dir + '/');
}

// Every context closed and every microphone track stopped once nothing runs.
function expectReleased(env) {
  expect(env.state.closed).toBe(env.state.contexts.length);
  expect(env.state.stoppedTracks).toBe(env.state.streams);
}

let env;
beforeEach(() => { env = installBrowser(); });
afterEach(() => env.restore());

describe('start() and stop() racing', () => {
  test('start, stop, start while the first start is still opening: the second start runs', async () => {
    const errors = [];
    let notes = 0;
    const d = P.create({ onError: (e) => errors.push(e), onNotes: () => notes++ });
    const first = d.start();
    d.stop();
    const second = d.start();
    await Promise.all([first, second]);
    expect(d.running).toBe(true);
    expect(errors).toEqual([]);
    env.ctx.render(CHORD.subarray(0, 24000));
    await until(() => notes > 10);
    d.stop();
    expectReleased(env);
  }, 30_000);

  test('stop() while the engine is being built, then start() again', async () => {
    env.restore(); env = installBrowser({ workletDelayMs: 100 });
    const d = P.create();
    const first = d.start();
    await until(() => env.state.contexts[0].sources.length === 1); // the microphone is open; the engine is being built
    d.stop();
    const second = d.start();
    await Promise.all([first, second]);
    expect(d.running).toBe(true);
    expect(env.state.nodes.length).toBe(1); // the cancelled start built nothing
    d.stop();
    expectReleased(env);
  }, 30_000);

  test('stop() while waiting for the context to resume cancels quietly, for every model', async () => {
    env.restore(); env = installBrowser({ startSuspended: true, resumeDelayMs: 1000 });
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const model of ['fast', 'fft']) {
        const errors = [];
        const d = P.create({ model, onError: (e) => errors.push(e) });
        const p = d.start();
        await settle(60); // past the microphone, inside the 200 ms resume wait
        d.stop();
        await p;
        expect(d.running).toBe(false);
        expect(errors).toEqual([]);
        const d2 = P.create({ model }); // without onError, start() resolves too: it was cancelled, not failed
        const p2 = d2.start();
        await settle(60);
        d2.stop();
        expect(await p2.then(() => 'ok', (e) => `rejected ${e}`)).toBe('ok');
      }
      expectReleased(env);
      await settle(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);

  test('a start that stop() cancelled does not report its later failure', async () => {
    env.restore(); env = installBrowser({ micError: 'NotAllowedError', micDelayMs: 20 });
    const errors = [];
    const d = P.create({ onError: (e) => errors.push(e) });
    const p = d.start();
    d.stop();
    await p;
    expect(errors).toEqual([]);
    expect(await P.create().start().then(() => 'ok', (e) => e.code)).toBe('mic-denied'); // not cancelled: rejects
  });

  test('two clicks on start with onError: both resolve, onError hears the failure once', async () => {
    env.restore(); env = installBrowser({ micError: 'NotAllowedError' });
    const codes = [];
    const d = P.create({ onError: (e) => codes.push(e.code) });
    const r = await Promise.allSettled([d.start(), d.start()]);
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(codes).toEqual(['mic-denied']);
    // without onError, both callers see the rejection
    const d2 = P.create();
    const r2 = await Promise.allSettled([d2.start(), d2.start()]);
    expect(r2.map((x) => x.reason?.code)).toEqual(['mic-denied', 'mic-denied']);
  });

  test('onError can retry start() right away', async () => {
    env.restore(); env = installBrowser({ micError: ['NotAllowedError'] }); // denied once, then granted
    let attempts = 0;
    const d = P.create({ onError: () => { if (++attempts === 1) d.start(); } });
    await d.start();
    await until(() => d.running);
    expect(attempts).toBe(1);
    expect(env.state.micCalls).toBe(2);
    d.stop();
  });

  test('stop() from inside the first frame sticks, and start() works again', async () => {
    let stopped = false;
    const d = P.create({ model: 'fft', onNotes: () => { if (!stopped) { stopped = true; d.stop(); } } });
    await d.start(); // the fft engine delivers its first frame while it is being installed
    expect(stopped).toBe(true);
    expect(d.running).toBe(false);
    await d.start();
    expect(d.running).toBe(true);
    d.stop();
    expectReleased(env);
  });

  test('stop() clears pause: start() afterwards detects', async () => {
    let n = 0;
    const d = P.create({ onNotes: () => n++ });
    await d.start();
    expect(d.togglePause()).toBe(true);
    d.stop();
    expect(d.paused).toBe(false);
    await d.start();
    env.ctx.render(CHORD.subarray(0, 24000));
    await until(() => n > 10);
    d.stop();
  });
});

describe('setModel() racing start() and itself', () => {
  test('setModel during start(): the new model is built once, with no spurious chord end', async () => {
    let ends = 0;
    const d = P.create({ onChordEnd: () => ends++ });
    const started = d.start();
    const switched = d.setModel('piano');
    await Promise.all([started, switched]);
    expect(d.stats.model).toBe('piano');
    expect(env.state.nodes.length).toBe(1);
    expect(ends).toBe(0);
    d.stop();
  });

  test('switching away and straight back keeps the running engine', async () => {
    const d = P.create();
    await d.start();
    const a = d.setModel('piano'), b = d.setModel('fast');
    await Promise.all([a, b]);
    expect(d.model).toBe('fast');
    expect(d.stats.model).toBe('fast');
    expect(env.state.nodes.length).toBe(1); // piano was never built
    expect(env.ctx.sources[0].targets.has(env.state.nodes[0])).toBe(true);
    d.stop();
  });

  test('a model that cannot be built keeps the old one running and selected', async () => {
    const errors = [];
    let notes = 0;
    const d = P.create({ modelBaseUrl: brokenPianoDir(), onError: (e) => errors.push(e), onNotes: () => notes++ });
    await d.start();
    await d.setModel('piano');
    expect(errors.map((e) => e.code)).toEqual(['processor-error']);
    expect(errors[0].message).toMatch(/'piano' detector stopped in the audio thread/);
    expect(d.running).toBe(true);
    expect(d.model).toBe('fast');
    expect(d.stats.model).toBe('fast');
    env.ctx.render(CHORD.subarray(0, 24000));
    await until(() => notes > 10); // fast still detects
    // without onError, setModel() rejects and fast keeps running
    const d2 = P.create({ modelBaseUrl: brokenPianoDir() });
    await d2.start();
    expect(await d2.setModel('piano').then(() => 'ok', (e) => e.code)).toBe('processor-error');
    expect(d2.stats.model).toBe('fast');
    d.stop(); d2.stop();
  });

  test('a model that cannot be built fails start() and releases the microphone', async () => {
    const dir = brokenPianoDir();
    const errors = [];
    const d = P.create({ model: 'piano', modelBaseUrl: dir, onError: (e) => errors.push(e) });
    await d.start();
    expect(errors.map((e) => e.code)).toEqual(['processor-error']);
    expect(d.running).toBe(false);
    expect(await P.create({ model: 'piano', modelBaseUrl: dir }).start().then(() => 'ok', (e) => e.code)).toBe('processor-error');
    expectReleased(env);
  });

  test('a detector that dies later stops cleanly and says so; a replaced one stays quiet', async () => {
    const errors = [];
    const d = P.create({ onError: (e) => errors.push(e) });
    await d.start();
    await d.setModel('piano');
    const [oldNode, node] = env.state.nodes;
    oldNode.onprocessorerror?.(); // the replaced engine's crash is not this detector's problem
    await settle(10);
    expect(errors).toEqual([]);
    node.processor.port.postMessage({ type: 'error', message: 'out of memory' }); // the running one dies
    await until(() => errors.length > 0);
    expect(errors[0].code).toBe('processor-error');
    expect(errors[0].message).toMatch(/'piano' detector stopped in the audio thread: out of memory/);
    expect(d.running).toBe(false);
    expectReleased(env);
    await d.start(); // and it can be started again
    expect(d.running).toBe(true);
    d.stop();
  });

  test("under 'auto', a kernel that fails in the audio thread falls back to JavaScript", async () => {
    // a stand-in WASM choice: its bytes load, but this worklet build has no 'wasm' kernel to run them
    const dir = mkdtempSync(`${tmpdir()}/pp-kernel-`);
    writeFileSync(`${dir}/k.wasm`, SIMD_PROBE);
    CHOICES.unshift({ id: 'wasm-test', impl: 'wasm', probe: SIMD_PROBE, wasm: () => new URL(`file://${dir}/k.wasm`) });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = P.create();
      await d.start();
      expect(d.stats.kernel).toBe('js');
      expect(warn.mock.calls[0][0]).toMatch(/'wasm-test' kernel failed in the audio thread.*JavaScript kernel/);
      d.stop();
      const errors = [];
      const named = P.create({ kernel: 'wasm-test', onError: (e) => errors.push(e) });
      await named.start(); // named explicitly: no fallback
      expect(errors.map((e) => e.code)).toEqual(['processor-error']);
    } finally {
      CHOICES.shift();
      warn.mockRestore();
    }
  });
});

describe('browser quirks', () => {
  test('a microphone that cannot feed a 48 kHz context: the device rate is used and decodes like analyze()', async () => {
    env.restore(); env = installBrowser({ deviceRate: 44100 });
    const x = fixture('chord-a-major');
    const { createResampler } = await import('../engine/resample.js');
    const r = createResampler(48000, 44100);
    const at44 = Float32Array.from([...r.push(x.samples), ...r.push(new Float32Array(480))]);
    const frames = [];
    const d = P.create({ onNotes: (n, f) => frames.push(f) });
    await d.start();
    expect(env.ctx.sampleRate).toBe(44100);
    expect(env.state.contexts.length).toBe(2); // the 48 kHz attempt, closed
    env.ctx.render(at44);
    const offline = await P.analyze(at44, 44100);
    await until(() => frames.length >= offline.length - 3);
    for (let i = 0; i < frames.length; i++) expect(frames[i].notes).toEqual(offline[i].notes);
    d.stop();
    expectReleased(env);
  }, 30_000);

  test('a context that stays suspended resumes on the next click or key; stop() removes the listeners', async () => {
    env.restore(); env = installBrowser({ startSuspended: true, resumeDelayMs: Infinity });
    const d = P.create();
    await d.start();
    expect(d.running).toBe(true);
    expect(env.ctx.state).toBe('suspended');
    expect(env.state.listeners.get('pointerdown').size).toBe(1);
    const resume = spyOn(env.ctx, 'resume');
    env.dispatch('pointerdown');
    expect(resume).toHaveBeenCalled();
    d.stop();
    expect(env.state.listeners.get('pointerdown').size).toBe(0);
    expect(env.state.listeners.get('keydown').size).toBe(0);
  });

  test('frame.time leaves out paused time (fft)', async () => {
    const times = [];
    const d = P.create({ model: 'fft', onNotes: (n, f) => times.push(f.time) });
    env.tick(1000);
    await d.start(); // first frame at install
    env.tick(1100);
    d.togglePause();
    env.tick(5000); // nothing runs while paused
    env.tick(6000);
    d.togglePause(); // resumes with a frame
    env.tick(6100);
    expect(times.at(-1) - times[0]).toBeCloseTo(0.2, 2); // 0.1 s before the pause + 0.1 s after
    d.stop();
  });
});

describe('errors are always coded', () => {
  test('a stream without an audio track, or that is not a stream', async () => {
    const code = (p) => p.then(() => 'ok', (e) => (e instanceof P.PitchPleaseError ? e.code : `uncoded ${e}`));
    expect(await code(P.create().start(new env.MediaStream({ audio: false })))).toBe('bad-source');
    expect(await code(P.create().start({}))).toBe('bad-source');
    // a stream from another realm (an iframe) is not instanceof this window's MediaStream, but works
    const foreign = { getTracks: () => [], getAudioTracks: () => [{ kind: 'audio' }] };
    const d = P.create();
    expect(await code(d.start(foreign))).toBe('ok');
    d.stop();
  });

  test('switching from fft to a trained model where AudioWorklet is missing', async () => {
    env.restore(); env = installBrowser({ worklet: false });
    const errors = [];
    const d = P.create({ model: 'fft', onError: (e) => errors.push(e) });
    await d.start();
    await d.setModel('fast');
    expect(errors.map((e) => e.code)).toEqual(['worklet-unsupported']);
    expect(d.model).toBe('fft');
    expect(d.running).toBe(true);
    d.stop();
  });

  test('an unexpected browser failure arrives as internal-error with the cause', async () => {
    env.restore(); env = installBrowser({ ctxError: 'too many AudioContexts' });
    const e = await P.create().start().catch((x) => x);
    expect(e).toBeInstanceOf(P.PitchPleaseError);
    expect(e.code).toBe('internal-error');
    expect(e.message).toMatch(/too many AudioContexts/);
    expect(e.cause.message).toBe('too many AudioContexts');
  });
});

describe('start() and setModel() resolve to what happened', () => {
  test('start(): true once detecting; false when it failed (with onError) or stop() cancelled it', async () => {
    const d = P.create();
    expect(await d.start()).toBe(true);
    expect(await d.start()).toBe(true); // already running: the same outcome
    d.stop();
    const cancelled = d.start();
    d.stop();
    expect(await cancelled).toBe(false);
    env.restore(); env = installBrowser({ micError: 'NotAllowedError' });
    const errors = [];
    expect(await P.create({ onError: (e) => errors.push(e) }).start()).toBe(false);
    expect(errors.map((e) => e.code)).toEqual(['mic-denied']);
  });

  test('setModel(): the model running afterwards (null when nothing runs)', async () => {
    const errors = [];
    const d = P.create({ modelBaseUrl: brokenPianoDir(), onError: (e) => errors.push(e.code) });
    expect(await d.setModel('fft')).toBe(null); // not started: selected, nothing runs yet
    expect(await d.setModel('fast')).toBe(null);
    await d.start();
    expect(await d.setModel('piano')).toBe('fast'); // piano cannot be built: fast keeps running
    expect(await d.setModel('loud')).toBe('fast'); // unknown id
    expect(await d.setModel('fft')).toBe('fft');
    expect(await d.setModel('fft')).toBe('fft'); // already running it
    const p = d.setModel('fast');
    d.stop();
    expect(await p).toBe(null);
    expect(errors).toEqual(['processor-error', 'unknown-model']);
  });
});
