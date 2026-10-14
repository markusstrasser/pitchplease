// A scripted stand-in for the browser pieces PitchPlease touches: getUserMedia, AudioContext, AnalyserNode,
// requestAnimationFrame, performance.now and AudioWorklet. The worklet runs the real generated engine/worklet.js
// in-process: AudioWorkletNode builds its processor with the real processorOptions and a MessageChannel, and
// ctx.render(samples) feeds it audio one render quantum at a time.
const GLOBALS = ['window', 'navigator', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'AudioContext',
  'AudioWorkletNode', 'AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'MediaStream', 'isSecureContext',
  'addEventListener', 'removeEventListener'];

const processors = new Map(); // name -> class, filled when engine/worklet.js is evaluated
let pendingPort = null;
let workletLoaded = null;

// Options that script the awkward cases:
//   micError: 'NotAllowedError' (every call) or ['NotAllowedError'] (one entry per call, then the mic opens)
//   micDelayMs, resumeDelayMs, workletDelayMs: how long getUserMedia, AudioContext.resume() and
//     audioWorklet.addModule() take (Infinity: never)
//   startSuspended: contexts start 'suspended' until resume() completes; close() rejects a pending resume, as
//     Chromium does
//   deviceRate: the microphone's rate; createMediaStreamSource throws NotSupportedError into a context at any other
//     rate (older Firefox), and new AudioContext() without a sampleRate runs at it
//   ctxError: new AudioContext() throws this message
export function installBrowser({ sampleRate = 48000, micError = null, worklet = true, spectrum = () => null, micDelayMs = 0,
  resumeDelayMs = 0, workletDelayMs = 0, startSuspended = false, deviceRate = null, ctxError = null } = {}) {
  const saved = new Map(GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const set = (k, value) => Object.defineProperty(globalThis, k, { value, writable: true, configurable: true });
  const state = { clock: 0, raf: new Map(), rafId: 0, contexts: [], micCalls: 0, streams: 0, stoppedTracks: 0, closed: 0, listeners: new Map() };
  const micErrors = Array.isArray(micError) ? [...micError] : null;
  const wait = (ms) => (ms === Infinity ? new Promise(() => {}) : ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

  class MediaStream {
    constructor({ audio = true } = {}) { this.tracks = audio ? [{ kind: 'audio', stop: () => { state.stoppedTracks++; } }] : []; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  }

  class AudioNode {
    constructor(ctx) { this.context = ctx; this.targets = new Set(); }
    connect(n) { this.targets.add(n); return n; }
    disconnect(n) { if (n) { if (!this.targets.delete(n)) throw new Error('not connected'); } else this.targets.clear(); }
  }

  class AudioContext {
    constructor(opts = {}) {
      if (ctxError) throw new Error(ctxError);
      this.sampleRate = opts.sampleRate ?? deviceRate ?? sampleRate;
      this.renderSize = opts.renderSizeHint === 512 ? 512 : 128;
      this.state = startSuspended ? 'suspended' : 'running';
      this.destination = new AudioNode(this);
      this.sources = [];
      this.audioWorklet = { addModule: (url) => loadWorklet(url) };
      this.pendingResumes = [];
      state.contexts.push(this);
    }
    resume() {
      if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: context is closed'));
      const delay = wait(resumeDelayMs);
      if (!delay) { this.state = 'running'; return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        this.pendingResumes.push(reject);
        delay.then(() => { if (this.state !== 'closed') { this.state = 'running'; resolve(); } });
      });
    }
    close() {
      if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: already closed'));
      this.state = 'closed'; state.closed++;
      for (const reject of this.pendingResumes.splice(0)) reject(new Error('Audio context is going away'));
      return Promise.resolve();
    }
    createMediaStreamSource(stream) {
      if (deviceRate && this.sampleRate !== deviceRate) { const e = new Error('sample rates differ'); e.name = 'NotSupportedError'; throw e; }
      const s = new AudioNode(this); s.stream = stream; this.sources.push(s); return s;
    }
    createAnalyser() {
      const a = new AudioNode(this);
      a.fftSize = 2048;
      Object.defineProperty(a, 'frequencyBinCount', { get: () => a.fftSize / 2 });
      a.getByteFrequencyData = (arr) => { const s = spectrum(); arr.fill(0); if (s) arr.set(s.subarray(0, arr.length)); };
      return a;
    }
    // Feed audio through every source's connected worklet nodes, one render quantum at a time.
    render(samples) {
      const q = this.renderSize, out = [[new Float32Array(q)]];
      for (let i = 0; i + q <= samples.length; i += q) {
        const input = [[samples.subarray(i, i + q)]];
        for (const s of this.sources) for (const n of s.targets) if (n.processor && n.alive) n.alive = n.processor.process(input, out) !== false;
      }
    }
  }

  class AudioWorkletProcessor {
    constructor() { this.port = pendingPort; pendingPort = null; }
  }

  class AudioWorkletNode extends AudioNode {
    constructor(ctx, name, options = {}) {
      super(ctx);
      const Proc = processors.get(name);
      if (!Proc) throw new Error(`AudioWorkletNode: no processor '${name}' registered`);
      const { port1, port2 } = new MessageChannel();
      this.port = port1;
      pendingPort = port2;
      globalThis.sampleRate = ctx.sampleRate;
      this.processor = new Proc({ ...options, processorOptions: structuredClone(options.processorOptions) });
      this.alive = true;
      this._ports = [port1, port2];
      state.nodes = (state.nodes ?? []).concat(this);
    }
  }

  async function loadWorklet(url) {
    if (!worklet) throw new Error('worklet disabled');
    await wait(workletDelayMs);
    workletLoaded ??= import(String(url));
    await workletLoaded;
  }

  const navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        state.micCalls++;
        await wait(micDelayMs);
        const name = micErrors ? micErrors.shift() : micError;
        if (name) { const e = new Error(name); e.name = name; throw e; }
        state.streams++;
        return new MediaStream();
      },
    },
  };
  const listenersOf = (type) => state.listeners.get(type) ?? state.listeners.set(type, new Set()).get(type);

  set('window', globalThis);
  set('navigator', navigator);
  set('performance', { now: () => state.clock });
  set('requestAnimationFrame', (cb) => { state.raf.set(++state.rafId, cb); return state.rafId; });
  set('cancelAnimationFrame', (id) => { state.raf.delete(id); });
  set('AudioContext', AudioContext);
  set('MediaStream', MediaStream);
  set('isSecureContext', true);
  set('AudioWorkletProcessor', AudioWorkletProcessor);
  set('registerProcessor', (name, cls) => { processors.set(name, cls); });
  set('addEventListener', (type, fn) => { listenersOf(type).add(fn); });
  set('removeEventListener', (type, fn) => { listenersOf(type).delete(fn); });
  if (worklet) set('AudioWorkletNode', AudioWorkletNode);
  else delete globalThis.AudioWorkletNode;

  return {
    state, MediaStream,
    /** Run every pending animation frame once, at clock ms. */
    tick(ms) {
      state.clock = ms;
      const cbs = [...state.raf.values()];
      state.raf.clear();
      for (const cb of cbs) cb(ms);
    },
    get ctx() { return state.contexts.at(-1); },
    /** Fire a window event (e.g. 'pointerdown') at the registered listeners. */
    dispatch(type) { for (const fn of [...listenersOf(type)]) fn({ type }); },
    restore() {
      for (const n of state.nodes ?? []) for (const p of n._ports) p.close();
      for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    },
  };
}

/** Wait until the message queue has drained (worklet port messages are delivered asynchronously). */
export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
