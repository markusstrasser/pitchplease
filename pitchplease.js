/**
 * PitchPlease v3: polyphonic pitch and chord detection in the browser.
 *
 *   import { create } from '@markusstrasser/pitchplease';
 *   const detector = create({ onNotes: (notes) => console.log(notes.map((n) => n.name).join(' ')) });
 *   button.onclick = () => detector.start(); // the mic needs a user gesture and https:// or localhost
 *
 * Models: 'fast' (default), 'piano', 'voice' are trained detectors running in an AudioWorklet; 'fft' is the v2 FFT
 * peak picker. `models` lists them with their use case, download size, compute cost and measured accuracy.
 */
import { PitchPleaseError } from './engine/errors.js';
import { NOTE_NAMES, midiToNote, pitchClassToColor, matchChord, createChordHold } from './engine/music.js';
import { MODELS, getModel, loadModel } from './engine/models.js';
import { createTracker, KEY_COUNT, LOWEST_MIDI } from './engine/tracker.js';
import { fftConfig, startFftEngine, fftNotes, analyzeFftOffline } from './engine/fft.js';
import { pickKernel } from './engine/kernels.js';
import { resolveKernel } from './engine/kernel-load.js';
import { createResampler } from './engine/resample.js';

export { NOTE_NAMES, midiToNote, pitchClassToColor, matchChord, createChordHold, PitchPleaseError };
export const version = '3.0.0';
/** Model metadata for building pickers: id, label, useCase, sizeKB, relativeCost, latencyMs, pianoF1, ... */
export const models = MODELS;

const workletUrl = () => new URL('./engine/worklet.js', import.meta.url);
const KEY_MIDIS = Float32Array.from({ length: KEY_COUNT }, (_, k) => k + LOWEST_MIDI);
const NO_PEAKS = new Float32Array(0);
const ANALYZE_CHUNK = 128; // samples per push, as one Web Audio render quantum
const ANALYZE_TAIL_SECONDS = 0.25; // zeros appended so the last frames of the input are emitted

// ============ OPTIONS ============

function resolveThreshold(model, t) {
  if (!model.threshold) return null;
  if (t == null) return model.threshold;
  const on = t.on ?? model.threshold.on;
  const off = t.off ?? (t.on != null ? on * 0.6 : model.threshold.off);
  if (!(on > 0 && on < 1 && off > 0 && off <= on)) {
    throw new PitchPleaseError('bad-threshold', `threshold must satisfy 0 < off <= on < 1 (got on ${on}, off ${off}).`);
  }
  return { on, off };
}

function checkOptions(o) {
  if (o === null || typeof o !== 'object') throw new PitchPleaseError('bad-options', 'Options must be an object.');
  const m = getModel(o.model ?? 'fast');
  if (o.threshold != null) resolveThreshold(getModel('fast'), o.threshold);
  if (o.stabilityFrames != null && !(Number.isInteger(o.stabilityFrames) && o.stabilityFrames >= 1)) {
    throw new PitchPleaseError('bad-options', 'stabilityFrames must be a whole number >= 1.');
  }
  if (o.clearAfterMs != null && !(o.clearAfterMs >= 0)) throw new PitchPleaseError('bad-options', 'clearAfterMs must be >= 0.');
  pickKernel(o.kernel ?? 'auto'); // throws on an unknown kernel
  return m;
}

const trackerOptions = (o, model) => ({
  ...resolveThreshold(model, o.threshold),
  stabilityFrames: o.stabilityFrames ?? 1, // the trained models' hysteresis already steadies the keys
  clearAfterMs: o.clearAfterMs ?? 200,
});

// ============ FRAMES ============

function modelFrame(tracker, t, emit, probs) {
  const r = tracker.step(probs, t);
  return [{ time: t, emitTime: emit, probs, notes: r.notes, pitchClasses: r.pitchClasses, stable: r.stable, chord: r.chord }, r.event];
}

// v2's onUpdate payload for a trained-model frame: the 88 key probabilities stand in for the spectrum.
function modelUpdateData(frame, model, threshold) {
  let maxEnergy = 0;
  for (let k = 0; k < KEY_COUNT; k++) if (frame.probs[k] > maxEnergy) maxEnergy = frame.probs[k];
  return {
    spectrum: frame.probs, binMidi: KEY_MIDIS,
    fundMidis: Float32Array.from(frame.notes, (n) => n.midi), fundCount: frame.notes.length,
    pitchClasses: frame.pitchClasses, stable: frame.stable, chord: frame.chord,
    maxEnergy, threshold: threshold.on, peakBins: NO_PEAKS, peakEnergies: NO_PEAKS, peakCount: 0,
    notes: frame.notes, probs: frame.probs, model,
  };
}

function fftFrame(result, time) {
  const notes = fftNotes(result.data, result.fundScores);
  return { time, emitTime: time, probs: null, notes, pitchClasses: result.data.pitchClasses, stable: result.data.stable, chord: result.data.chord };
}

// ============ OFFLINE ============

function mixdown(buffer) {
  const n = buffer.numberOfChannels;
  if (n === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < n; c++) { const ch = buffer.getChannelData(c); for (let i = 0; i < out.length; i++) out[i] += ch[i] / n; }
  return out;
}

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
const now = () => (globalThis.performance ?? Date).now();

/**
 * Detect notes in recorded audio. Works in browsers and Node.
 *   analyze(samples: Float32Array, sampleRate, { model, threshold, ... })  or  analyze(audioBuffer, { model, ... })
 * Resolves to one frame per detector hop: { time, emitTime, probs, notes, pitchClasses, stable, chord }.
 */
export async function analyze(input, sampleRate, options) {
  if (input && typeof input.getChannelData === 'function' && typeof input.numberOfChannels === 'number') {
    options = sampleRate; sampleRate = input.sampleRate; input = mixdown(input);
  }
  options = options ?? {};
  const model = checkOptions(options);
  if (!(input instanceof Float32Array)) {
    if (!(ArrayBuffer.isView(input) || Array.isArray(input))) {
      throw new PitchPleaseError('bad-input', 'analyze() takes (samples: Float32Array, sampleRate) or an AudioBuffer.');
    }
    input = Float32Array.from(input);
  }
  if (!(sampleRate > 0)) throw new PitchPleaseError('bad-input', 'analyze(samples, sampleRate): sampleRate must be a positive number (Hz).');
  const duration = input.length / sampleRate;

  if (model.id === 'fft') {
    return analyzeFftOffline(input, sampleRate, { ...options, stabilityFrames: options.stabilityFrames ?? 4 }, fftFrame);
  }

  const [{ manifest, weights }, kernel] = await Promise.all([loadModel(model.id, options.modelBaseUrl), resolveKernel(options.kernel, 'module')]);
  // The kernel takes 48 kHz (its own resampler) and 22.05 kHz; other rates are resampled to 22.05 kHz first.
  const direct = sampleRate === 48000 || sampleRate === 22050;
  const rate = direct ? sampleRate : 22050;
  const resampler = direct ? null : createResampler(sampleRate, 22050);
  const det = kernel.impl.createDetector(kernel.impl.parseWeights(manifest, weights), { inputRate: rate, wasmModule: kernel.wasm });
  const tracker = createTracker(trackerOptions(options, model));
  const frames = [];
  const take = (out) => {
    for (const f of out) if (f.t < duration) frames.push(modelFrame(tracker, f.t, f.emit, f.probs)[0]);
  };
  const tail = new Float32Array(Math.ceil(ANALYZE_TAIL_SECONDS * sampleRate));
  let lastYield = now();
  for (const x of [input, tail]) {
    for (let i = 0; i < x.length; i += ANALYZE_CHUNK) {
      const chunk = x.subarray(i, Math.min(i + ANALYZE_CHUNK, x.length));
      take(det.push(resampler ? resampler.push(chunk) : chunk));
      if (now() - lastYield > 50) { await yieldToEventLoop(); lastYield = now(); }
    }
  }
  return frames;
}

// ============ LIVE ============

const worklets = new WeakMap(); // AudioContext -> Promise (addModule once per context)

function addWorklet(ctx) {
  if (!worklets.has(ctx)) {
    const url = workletUrl();
    worklets.set(ctx, ctx.audioWorklet.addModule(url).catch((e) => {
      worklets.delete(ctx);
      throw new PitchPleaseError('worklet-load-failed',
        `Could not load the audio worklet from ${url.href} (${e.message}). Serve the package's engine/ folder as JavaScript; ` +
        'with a bundler, engine/worklet.js must be emitted as its own file.', { cause: e });
    }));
  }
  return worklets.get(ctx);
}

function checkBrowser(model, needMic) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof window === 'undefined' || !AC) {
    throw new PitchPleaseError('no-web-audio', 'start() needs a browser with the Web Audio API. To analyze recorded audio (also in Node), use analyze().');
  }
  const insecure = globalThis.isSecureContext === false;
  const where = `this page is ${globalThis.location?.origin ?? 'not https'}`;
  if (needMic && !globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw insecure
      ? new PitchPleaseError('insecure-context', `The microphone needs a secure page: serve it over https:// or from http://localhost (${where}).`)
      : new PitchPleaseError('no-microphone-api', 'This browser has no navigator.mediaDevices.getUserMedia, so it cannot open a microphone.');
  }
  if (model !== 'fft' && typeof AudioWorkletNode === 'undefined') {
    throw insecure
      ? new PitchPleaseError('insecure-context', `AudioWorklet needs a secure page: serve it over https:// or from http://localhost (${where}).`)
      : new PitchPleaseError('worklet-unsupported', `This browser has no AudioWorklet, which the '${model}' model needs. Use a current Chrome, Edge, Firefox or Safari, or model: 'fft'.`);
  }
  return AC;
}

async function openMicrophone() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      throw new PitchPleaseError('mic-denied', 'Microphone access was denied. Allow it for this site (the icon left of the address bar), then call start() again.', { cause: e });
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      throw new PitchPleaseError('mic-not-found', 'No microphone was found. Connect one, or pass a MediaStream to start(stream).', { cause: e });
    }
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
      throw new PitchPleaseError('mic-busy', 'The microphone could not be opened; another app or tab may be using it.', { cause: e });
    }
    throw new PitchPleaseError('mic-failed', `Could not open the microphone: ${e && e.message || e}`, { cause: e });
  }
}

const reportLater = (e) => setTimeout(() => { throw e; }); // a throwing callback must not stop detection
function call(fn, ...args) {
  if (!fn) return;
  try { fn(...args); } catch (e) { reportLater(e); }
}

/**
 * Create a live detector. Nothing is downloaded or opened until start().
 * Errors go to onError when given; otherwise start() and setModel() reject with a PitchPleaseError.
 */
export function create(options = {}) {
  let model = checkOptions(options).id;
  const { onNotes, onChord, onChordEnd, onUpdate, onError } = options;

  let ctx = null, source = null, stream = null, ownStream = false;
  let engine = null;
  let running = false, paused = false, heldChord = null;
  let generation = 0, swaps = 0, starting = null;

  function fail(e) {
    if (onError) call(onError, e);
    else throw e;
  }
  const report = (e) => (onError ? call(onError, e) : console.error(e));

  function deliver(eng, frame, event, data) {
    if (eng !== engine || paused) return;
    call(onNotes, frame.notes, frame);
    if (event === 'chord') { heldChord = frame.chord; call(onChord, frame.chord); }
    else if (event === 'clear') { heldChord = null; call(onChordEnd); }
    if (onUpdate) call(onUpdate, data());
  }

  async function buildEngine(id, gen) {
    const m = getModel(id);
    if (m.id === 'fft') {
      const eng = { model: 'fft', kernel: null };
      const t0 = performance.now();
      const live = startFftEngine({
        ctx, source, config: fftConfig(options),
        onStep: (r, t) => {
          const frame = fftFrame(r, (t - t0) / 1000);
          deliver(eng, frame, r.event, () => Object.assign(r.data, { notes: frame.notes, probs: null, model: 'fft' }));
        },
      });
      Object.assign(eng, { stats: live.stats, begin: live.begin, setPaused: live.setPaused, stop: live.stop });
      return eng;
    }
    const [{ manifest, weights }, kernel] = await Promise.all([loadModel(m.id, options.modelBaseUrl), resolveKernel(options.kernel, 'bytes'), addWorklet(ctx)]);
    if (gen !== generation) return null;
    const node = new AudioWorkletNode(ctx, 'pitchplease', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { manifest, weights, impl: kernel.choice.impl, wasmBytes: kernel.wasm },
    });
    const tracker = createTracker(trackerOptions(options, m));
    const threshold = resolveThreshold(m, options.threshold);
    const eng = { model: m.id, kernel: kernel.choice.id, stats: { cpuLoad: 0, framesPerSecond: 0 } };
    node.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'frame') {
        if (eng !== engine || paused) return;
        const [frame, event] = modelFrame(tracker, msg.t, msg.emit, msg.probs);
        deliver(eng, frame, event, () => modelUpdateData(frame, m.id, threshold));
      } else if (msg.type === 'stats') {
        eng.stats.cpuLoad = msg.cpuLoad; eng.stats.framesPerSecond = msg.framesPerSecond;
      } else if (msg.type === 'error') {
        report(new PitchPleaseError('processor-error', `The '${m.id}' detector stopped in the audio thread: ${msg.message}`));
      }
    };
    node.onprocessorerror = () => report(new PitchPleaseError('processor-error', `The '${m.id}' detector crashed in the audio thread.`));
    source.connect(node);
    node.connect(ctx.destination); // keeps the node pulled; it outputs silence
    Object.assign(eng, {
      begin() {},
      setPaused(p) { node.port.postMessage({ type: 'pause', paused: p }); },
      stop() {
        try { source.disconnect(node); } catch {}
        try { node.disconnect(); } catch {}
        node.port.postMessage({ type: 'stop' });
        node.port.onmessage = null;
      },
    });
    return eng;
  }

  function install(eng) {
    engine = eng;
    if (paused) eng.setPaused(true);
    eng.begin();
  }

  function teardown() {
    generation++;
    running = false;
    engine?.stop(); engine = null;
    try { source?.disconnect(); } catch {}
    if (ownStream) stream?.getTracks().forEach((t) => t.stop());
    ctx?.close().catch(() => {});
    ctx = source = stream = null; ownStream = false; heldChord = null;
  }

  async function start(input) {
    if (running) return;
    if (starting) return starting;
    const gen = ++generation;
    starting = (async () => {
      if (input != null && !(typeof MediaStream !== 'undefined' && input instanceof MediaStream)) {
        throw new PitchPleaseError('bad-source', 'start(source): source must be a MediaStream, or nothing to use the microphone.');
      }
      const AC = checkBrowser(model, input == null);
      // Create the context inside the user gesture (before the permission prompt) so it starts running.
      ctx = new AC({ sampleRate: 48000, renderSizeHint: 512 });
      const resumed = ctx.resume().catch(() => {});
      if (model !== 'fft') { loadModel(model, options.modelBaseUrl).catch(() => {}); addWorklet(ctx).catch(() => {}); }
      const s = input ?? await openMicrophone();
      if (gen !== generation) { if (input == null) s.getTracks().forEach((t) => t.stop()); return; }
      stream = s; ownStream = input == null;
      try {
        source = ctx.createMediaStreamSource(stream);
      } catch (e) {
        // Browsers that cannot resample a microphone into a 48 kHz context: use the device rate; the worklet resamples.
        if (e && e.name !== 'NotSupportedError') throw e;
        ctx.close().catch(() => {});
        ctx = new AC();
        source = ctx.createMediaStreamSource(stream);
        if (ctx.state === 'suspended') {
          const wake = () => ctx?.resume();
          ctx.resume();
          for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener?.(ev, wake, { once: true });
        }
      }
      await Promise.race([resumed, new Promise((r) => setTimeout(r, 200))]);
      const eng = await buildEngine(model, gen);
      if (gen !== generation || !eng) { eng?.stop(); return; }
      install(eng);
      running = true;
    })();
    try {
      await starting;
    } catch (e) {
      if (gen === generation) teardown();
      fail(e);
    } finally {
      starting = null;
    }
  }

  function stop() {
    teardown();
  }

  function togglePause() {
    paused = !paused;
    engine?.setPaused(paused);
    return paused;
  }

  async function setModel(id) {
    let prevModel = model;
    try {
      const m = getModel(id);
      if (m.id === model) return;
      model = m.id;
      if (!running && !starting) {
        if (m.id !== 'fft') loadModel(m.id, options.modelBaseUrl).catch(() => {}); // warm the cache for start()
        return;
      }
      if (starting) await starting.catch(() => {});
      if (!running) return;
      prevModel = engine?.model ?? prevModel;
      const gen = generation, swap = ++swaps;
      const next = await buildEngine(m.id, gen);
      if (gen !== generation || swap !== swaps || !next) { next?.stop(); return; }
      const prev = engine;
      install(next);
      prev?.stop();
      if (heldChord) { heldChord = null; call(onChordEnd); }
    } catch (e) {
      if (model === id) model = prevModel;
      fail(e);
    }
  }

  return {
    start, stop, togglePause, setModel,
    get paused() { return paused; },
    get running() { return running; },
    get model() { return model; },
    get stats() {
      return {
        model: engine?.model ?? model, kernel: engine?.kernel ?? null,
        cpuLoad: engine?.stats.cpuLoad ?? 0, framesPerSecond: engine?.stats.framesPerSecond ?? 0,
        sampleRate: ctx?.sampleRate ?? 0,
      };
    },
  };
}

export default { create, analyze, models, version, matchChord, createChordHold, midiToNote, pitchClassToColor, NOTE_NAMES, PitchPleaseError };
