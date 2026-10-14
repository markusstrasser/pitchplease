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
import { MODELS, getModel, loadModel, modelUrl } from './engine/models.js';
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
const RESUME_WAIT_MS = 200; // start() waits this long for the context to resume, then builds the engine anyway
const READY_WAIT_MS = 2000; // a new worklet engine has this long to report its detector built; later failures stop it
const NOT_READY = Symbol('not ready');

// ============ OPTIONS AND ERRORS ============

function resolveThreshold(model, t) {
  if (!model.threshold) return null;
  if (t == null) return model.threshold;
  const on = t.on ?? model.threshold.on;
  const off = t.off ?? (t.on != null ? on * 0.6 : model.threshold.off);
  if (!(on > 0 && on < 1 && off > 0 && off <= on)) {
    throw new PitchPleaseError('bad-threshold', `threshold must satisfy 0 < off <= on < 1 (for '${model.id}': on ${on}, off ${off}).` +
      (t.on == null ? ' Give `on` as well.' : ''));
  }
  return { on, off };
}

const isPowerOfTwo = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

function checkOptions(o) {
  if (o === null || typeof o !== 'object') throw new PitchPleaseError('bad-options', 'Options must be an object.');
  const m = getModel(o.model ?? 'fast');
  if (o.threshold != null) {
    if (typeof o.threshold !== 'object') throw new PitchPleaseError('bad-threshold', 'threshold must be an object: { on, off }.');
    resolveThreshold(m, o.threshold); // setModel() checks the model it switches to
  }
  if (o.stabilityFrames != null && !(Number.isInteger(o.stabilityFrames) && o.stabilityFrames >= 1)) {
    throw new PitchPleaseError('bad-options', 'stabilityFrames must be a whole number >= 1.');
  }
  if (o.clearAfterMs != null && !(o.clearAfterMs >= 0)) throw new PitchPleaseError('bad-options', 'clearAfterMs must be >= 0.');
  if (o.fftSize != null && !(isPowerOfTwo(o.fftSize) && o.fftSize >= 32 && o.fftSize <= 32768)) {
    throw new PitchPleaseError('bad-options', 'fftSize must be a power of two from 32 to 32768.');
  }
  const bins = (o.fftSize ?? 16384) / 2;
  if (o.binCount != null && !(Number.isInteger(o.binCount) && o.binCount >= 1 && o.binCount <= bins)) {
    throw new PitchPleaseError('bad-options', `binCount must be a whole number from 1 to fftSize / 2 (${bins}).`);
  }
  pickKernel(o.kernel ?? 'auto'); // throws on an unknown kernel
  if (o.modelBaseUrl != null) modelUrl('fast', o.modelBaseUrl); // throws on a URL that cannot be resolved here
  return m;
}

const trackerOptions = (o, model) => ({
  ...resolveThreshold(model, o.threshold),
  stabilityFrames: o.stabilityFrames ?? 1, // the trained models' hysteresis already steadies the keys
  clearAfterMs: o.clearAfterMs ?? 200,
});

/** Every error PitchPlease reports is a PitchPleaseError: anything unexpected becomes 'internal-error' with its cause. */
function coded(e) {
  if (e instanceof PitchPleaseError) return e;
  const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new PitchPleaseError('internal-error', `Unexpected error (${what}). The original error is the cause.`, { cause: e });
}

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

const now = () => (globalThis.performance ?? Date).now();

/** Returns a function that, every `ms` of busy time, gives back a promise that yields to the event loop (else null). */
function pacer(ms = 50) {
  let last = now();
  return () => (now() - last < ms ? null : new Promise((r) => setTimeout(r, 0)).then(() => { last = now(); }));
}

/**
 * Detect notes in recorded audio. Works in browsers and Node.
 *   analyze(samples: Float32Array, sampleRate, { model, threshold, ... })  or  analyze(audioBuffer, { model, ... })
 * Resolves to one frame per detector hop: { time, emitTime, probs, notes, pitchClasses, stable, chord }.
 */
export async function analyze(input, sampleRate, options) {
  try {
    return await analyzeInput(input, sampleRate, options);
  } catch (e) {
    throw coded(e);
  }
}

async function analyzeInput(input, sampleRate, options) {
  if (input && typeof input.getChannelData === 'function' && typeof input.numberOfChannels === 'number') {
    options = sampleRate; sampleRate = input.sampleRate; input = mixdown(input);
  }
  options = options ?? {};
  const model = checkOptions(options);
  if (!(input instanceof Float32Array)) {
    if (!(input !== null && typeof input === 'object' && typeof input.length === 'number' && !(input instanceof DataView))) {
      throw new PitchPleaseError('bad-input', 'analyze() takes (samples: a Float32Array or array of numbers, sampleRate) or an AudioBuffer.');
    }
    input = Float32Array.from(input);
  }
  if (!(sampleRate > 0)) throw new PitchPleaseError('bad-input', 'analyze(samples, sampleRate): sampleRate must be a positive number (Hz).');

  if (model.id === 'fft') {
    return analyzeFftOffline(input, sampleRate, { ...options, stabilityFrames: options.stabilityFrames ?? 4 }, fftFrame, pacer());
  }
  const preference = options.kernel ?? 'auto';
  const [loaded, kernel] = await Promise.all([loadModel(model.id, options.modelBaseUrl), resolveKernel(preference, 'module')]);
  try {
    return await decodeOffline(input, sampleRate, options, model, loaded, kernel);
  } catch (e) {
    if (preference !== 'auto' || kernel.choice.impl === 'js') throw e;
    console.warn(`[pitchplease] The '${kernel.choice.id}' kernel failed (${e.message}). Falling back to the JavaScript kernel.`);
    return decodeOffline(input, sampleRate, options, model, loaded, await resolveKernel('js', 'module'));
  }
}

async function decodeOffline(input, sampleRate, options, model, { manifest, weights }, kernel) {
  const duration = input.length / sampleRate;
  // The kernel takes 48 kHz (its own resampler) and 22.05 kHz; other rates are resampled to 22.05 kHz first.
  const direct = sampleRate === 48000 || sampleRate === 22050;
  const resampler = direct ? null : createResampler(sampleRate, 22050);
  let det;
  try {
    det = kernel.impl.createDetector(kernel.impl.parseWeights(manifest, weights), { inputRate: direct ? sampleRate : 22050, wasmModule: kernel.wasm });
  } catch (e) {
    throw new PitchPleaseError('model-load-failed', `The '${model.id}' weights do not build a detector (${e.message}).`, { cause: e });
  }
  const tracker = createTracker(trackerOptions(options, model));
  const frames = [];
  const tail = new Float32Array(Math.ceil(ANALYZE_TAIL_SECONDS * sampleRate));
  const pace = pacer();
  for (const x of [input, tail]) {
    for (let i = 0; i < x.length; i += ANALYZE_CHUNK) {
      const chunk = x.subarray(i, Math.min(i + ANALYZE_CHUNK, x.length));
      for (const f of det.push(resampler ? resampler.push(chunk) : chunk)) {
        if (f.t < duration) frames.push(modelFrame(tracker, f.t, f.emit, f.probs)[0]);
      }
      const due = pace();
      if (due) await due;
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

const where = () => `this page is ${globalThis.location?.origin ?? 'not https'}`;

function checkBrowser(model, needMic) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof window === 'undefined' || !AC) {
    throw new PitchPleaseError('no-web-audio', 'start() needs a browser with the Web Audio API. To analyze recorded audio (also in Node), use analyze().');
  }
  if (needMic && !globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw globalThis.isSecureContext === false
      ? new PitchPleaseError('insecure-context', `The microphone needs a secure page: serve it over https:// or from http://localhost (${where()}).`)
      : new PitchPleaseError('no-microphone-api', 'This browser has no navigator.mediaDevices.getUserMedia, so it cannot open a microphone.');
  }
  checkWorklet(model);
  return AC;
}

function checkWorklet(model) {
  if (model === 'fft' || typeof AudioWorkletNode !== 'undefined') return;
  throw globalThis.isSecureContext === false
    ? new PitchPleaseError('insecure-context', `AudioWorklet needs a secure page: serve it over https:// or from http://localhost (${where()}).`)
    : new PitchPleaseError('worklet-unsupported', `This browser has no AudioWorklet, which the '${model}' model needs. Use a current Chrome, Edge, Firefox or Safari, or model: 'fft'.`);
}

// Duck-typed so that a stream from another realm (an iframe) passes too.
const isStream = (x) => typeof x?.getTracks === 'function' && typeof x.getAudioTracks === 'function';

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

/** Resolves with `value` when `promise` has not settled within `ms`; the timer does not outlive the race. */
function within(promise, ms, value) {
  let timer;
  return Promise.race([promise, new Promise((r) => { timer = setTimeout(r, ms, value); })]).finally(() => clearTimeout(timer));
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

  // The current start(): { ctx, source, stream, ownStream, engine, running, unwake, started }. stop() drops it; a
  // start() that stop() overtook sees `session !== s` after each await and quietly releases what it opened.
  let session = null;
  let paused = false, heldChord = null, swaps = 0;

  function fail(e) {
    if (onError) call(onError, e);
    else throw e;
  }
  const report = (e) => (onError ? call(onError, e) : console.error(e));

  function deliver(eng, frame, event, data) {
    if (eng !== session?.engine || paused) return;
    call(onNotes, frame.notes, frame);
    if (eng !== session?.engine) return; // onNotes stopped or switched the detector
    if (event === 'chord') { heldChord = frame.chord; call(onChord, frame.chord); }
    else if (event === 'clear') { heldChord = null; call(onChordEnd); }
    if (onUpdate && eng === session?.engine) call(onUpdate, data());
  }

  // The running engine died in the audio thread: stop, and say why. A replaced engine's death is not reported.
  function engineFailed(eng, e) {
    if (eng !== session?.engine) return;
    teardown();
    report(e);
  }

  function fftEngine(s) {
    const eng = { model: 'fft', kernel: null };
    // frame.time counts unpaused time since begin(), as a worklet engine's audio clock does
    let t0 = 0, pausedAt = null, pausedMs = 0;
    const live = startFftEngine({
      ctx: s.ctx, source: s.source, config: fftConfig(options),
      onStep: (r, t) => {
        const frame = fftFrame(r, (t - t0 - pausedMs) / 1000);
        deliver(eng, frame, r.event, () => Object.assign(r.data, { notes: frame.notes, probs: null, model: 'fft' }));
      },
    });
    return Object.assign(eng, {
      stats: live.stats,
      begin() { t0 = performance.now(); live.begin(); },
      setPaused(p) {
        const t = performance.now();
        if (p && pausedAt === null) pausedAt = t;
        else if (!p && pausedAt !== null) { pausedMs += t - pausedAt; pausedAt = null; }
        live.setPaused(p);
      },
      stop: live.stop,
    });
  }

  // A trained model in an AudioWorkletNode. `ready` settles once the processor has built its detector: with null,
  // or with the message of the error that stopped it.
  function workletEngine(s, m, kernel, { manifest, weights }, tracker, threshold) {
    const node = new AudioWorkletNode(s.ctx, 'pitchplease', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { manifest, weights, impl: kernel.choice.impl, wasmBytes: kernel.wasm },
    });
    const eng = { model: m.id, kernel: kernel.choice.id, stats: { cpuLoad: 0, framesPerSecond: 0 }, installed: false };
    let settle;
    eng.ready = new Promise((r) => { settle = r; });
    const died = (message) => {
      if (!eng.installed) settle(message);
      else engineFailed(eng, new PitchPleaseError('processor-error', `The '${m.id}' detector stopped in the audio thread: ${message}`));
    };
    node.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'frame') {
        if (eng !== session?.engine || paused) return;
        const [frame, event] = modelFrame(tracker, msg.t, msg.emit, msg.probs);
        deliver(eng, frame, event, () => modelUpdateData(frame, m.id, threshold));
      } else if (msg.type === 'ready') {
        settle(null);
      } else if (msg.type === 'stats') {
        eng.stats.cpuLoad = msg.cpuLoad; eng.stats.framesPerSecond = msg.framesPerSecond;
      } else if (msg.type === 'error') {
        died(msg.message);
      }
    };
    node.onprocessorerror = () => died('it crashed');
    s.source.connect(node);
    node.connect(s.ctx.destination); // keeps the node pulled; it outputs silence
    return Object.assign(eng, {
      begin() {},
      setPaused(p) { node.port.postMessage({ type: 'pause', paused: p }); },
      stop() {
        try { s.source?.disconnect(node); } catch {}
        try { node.disconnect(); } catch {}
        node.port.postMessage({ type: 'stop' });
        node.port.onmessage = null;
        node.onprocessorerror = null;
        settle(null);
      },
    });
  }

  // The engine for model `id` on session s, or null once stale() (stop(), or a newer setModel()) made it pointless.
  // Under kernel 'auto', a WASM kernel that fails in the audio thread is replaced by the JavaScript one. mustBeReady
  // (setModel, which has a running engine to protect): no 'ready' within READY_WAIT_MS is a failure. start() has
  // nothing to protect and installs anyway, since a suspended context may build its processor only once it resumes.
  async function buildEngine(s, id, stale, { mustBeReady = false } = {}) {
    const m = getModel(id);
    if (m.id === 'fft') return fftEngine(s);
    checkWorklet(m.id);
    const threshold = resolveThreshold(m, options.threshold);
    const tracker = createTracker(trackerOptions(options, m));
    const preference = options.kernel ?? 'auto';
    const [loaded, first] = await Promise.all([loadModel(m.id, options.modelBaseUrl), resolveKernel(preference, 'bytes'), addWorklet(s.ctx)]);
    for (let kernel = first; ;) {
      if (stale()) return null;
      const eng = workletEngine(s, m, kernel, loaded, tracker, threshold);
      const failure = await within(eng.ready, READY_WAIT_MS, mustBeReady ? NOT_READY : null);
      if (stale()) { eng.stop(); return null; }
      if (failure === null) return eng;
      eng.stop();
      if (failure === NOT_READY) {
        throw new PitchPleaseError('processor-error', `The '${m.id}' detector did not report ready within ${READY_WAIT_MS / 1000} s.`);
      }
      if (preference !== 'auto' || kernel.choice.impl === 'js') {
        throw new PitchPleaseError('processor-error', `The '${m.id}' detector stopped in the audio thread: ${failure}`);
      }
      console.warn(`[pitchplease] The '${kernel.choice.id}' kernel failed in the audio thread (${failure}). Falling back to the JavaScript kernel.`);
      kernel = await resolveKernel('js', 'bytes');
    }
  }

  function install(s, eng) {
    s.engine = eng;
    eng.installed = true;
    s.running = true;
    if (paused) eng.setPaused(true);
    eng.begin(); // fft delivers its first frame here; a callback may stop() the detector
  }

  function release(s) {
    s.running = false;
    s.engine?.stop();
    s.engine = null;
    s.unwake?.();
    s.unwake = null;
    try { s.source?.disconnect(); } catch {}
    if (s.ownStream) s.stream?.getTracks().forEach((t) => t.stop());
    s.ctx?.close().catch(() => {});
    s.ctx = s.source = s.stream = null;
    s.ownStream = false;
  }

  function teardown() {
    const s = session;
    session = null;
    heldChord = null;
    paused = false;
    if (s) release(s);
  }

  function connectSource(s, AC) {
    try {
      return s.ctx.createMediaStreamSource(s.stream);
    } catch (e) {
      // Browsers that cannot resample a microphone into a 48 kHz context: use the device rate; the worklet resamples.
      if (e?.name !== 'NotSupportedError') throw e;
      s.ctx.close().catch(() => {});
      s.ctx = new AC();
      s.ctx.resume().catch(() => {});
      return s.ctx.createMediaStreamSource(s.stream);
    }
  }

  // A context still suspended (start() ran outside a click or key handler) resumes on the next click or key press.
  function wakeOnGesture(s) {
    if (typeof globalThis.addEventListener !== 'function') return;
    const ctx = s.ctx;
    const wake = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener(ev, wake, true);
    s.unwake = () => { for (const ev of ['pointerdown', 'keydown']) globalThis.removeEventListener(ev, wake, true); };
  }

  async function open(s, input) {
    if (input != null) {
      if (!isStream(input)) throw new PitchPleaseError('bad-source', 'start(source): source must be a MediaStream, or nothing to use the microphone.');
      if (!input.getAudioTracks().length) throw new PitchPleaseError('bad-source', 'start(source): the MediaStream has no audio track.');
    }
    const AC = checkBrowser(model, input == null);
    // Create the context inside the user gesture (before the permission prompt) so it starts running.
    s.ctx = new AC({ sampleRate: 48000, renderSizeHint: 512 });
    const resumed = s.ctx.resume().catch(() => {});
    if (model !== 'fft') { loadModel(model, options.modelBaseUrl).catch(() => {}); addWorklet(s.ctx).catch(() => {}); }
    const stream = input ?? await openMicrophone();
    s.stream = stream;
    s.ownStream = input == null;
    if (session !== s) { release(s); return false; }
    s.source = connectSource(s, AC);
    await within(resumed, RESUME_WAIT_MS);
    if (session !== s) return false;
    if (s.ctx.state === 'suspended') wakeOnGesture(s);
    const eng = await buildEngine(s, model, () => session !== s);
    if (eng) install(s, eng);
    return s.running; // false if a callback stopped it during install
  }

  function start(input) {
    if (session) return session.started; // running, or starting: share that outcome
    const s = { ctx: null, source: null, stream: null, ownStream: false, engine: null, running: false, unwake: null, started: null };
    session = s;
    s.started = open(s, input).catch((e) => {
      if (session !== s) return false; // stop() cancelled this start: nothing to report
      teardown(); // first, so that onError can call start() again
      fail(coded(e));
      return false;
    });
    return s.started;
  }

  function stop() {
    teardown();
  }

  function togglePause() {
    if (!session) return false; // nothing to pause before start(); stop() clears pause, so paused is false here
    paused = !paused;
    session?.engine?.setPaused(paused);
    return paused;
  }

  // The model whose engine runs now, or null.
  const runningModel = () => (session?.running ? session.engine.model : null);

  // Resolves the model running afterwards: id on success, the old model if the switch failed, null if none runs.
  async function setModel(id) {
    let m;
    try {
      m = getModel(id);
      resolveThreshold(m, options.threshold); // the threshold is absolute: it must fit the model switched to
    } catch (e) { fail(e); return runningModel(); }
    if (m.id === model) {
      if (session && !session.running) await session.started.catch(() => {});
      return runningModel();
    }
    const prev = model;
    model = m.id;
    const s = session;
    if (!s) { // not started: select it, and warm the cache for start()
      if (m.id !== 'fft') loadModel(m.id, options.modelBaseUrl).catch(() => {});
      return null;
    }
    const swap = ++swaps;
    const stale = () => session !== s || swap !== swaps;
    try {
      if (!s.running) await s.started.catch(() => {}); // starting: it may build this model itself
      if (stale() || !s.running || s.engine.model === m.id) return runningModel();
      const next = await buildEngine(s, m.id, stale, { mustBeReady: true });
      if (!next) return runningModel();
      if (heldChord) { heldChord = null; call(onChordEnd); } // the old engine still runs during this callback
      if (stale()) { next.stop(); return runningModel(); }
      const old = s.engine;
      install(s, next); // the new engine is ready: it takes over, and the old one retires
      old.stop();
      return runningModel();
    } catch (e) {
      if (swap === swaps) model = session === s && s.engine ? s.engine.model : prev;
      fail(coded(e));
      return runningModel();
    }
  }

  return {
    start, stop, togglePause, setModel,
    get paused() { return paused; },
    get running() { return session?.running === true; },
    get model() { return model; },
    get stats() {
      const eng = session?.engine;
      return {
        model: eng?.model ?? model, kernel: eng?.kernel ?? null,
        cpuLoad: eng?.stats.cpuLoad ?? 0, framesPerSecond: eng?.stats.framesPerSecond ?? 0,
        sampleRate: session?.ctx?.sampleRate ?? 0,
      };
    },
  };
}

export default { create, analyze, models, version, matchChord, createChordHold, midiToNote, pitchClassToColor, NOTE_NAMES, PitchPleaseError };
