// AudioWorkletProcessor running a trained detector on the input. Source of engine/worklet.js (scripts/build.mjs
// bundles this file and its imports into that one self-contained script; edit here, then `npm run build`).
//
// processorOptions: { manifest, weights: ArrayBuffer, impl: 'js' | 'wasm', wasmBytes?: ArrayBuffer }
// Posts { type: 'ready' } once the detector is built, { type: 'frame', t, emit, probs } per detector frame,
// { type: 'stats', cpuLoad, framesPerSecond } every ~0.5 s of audio, and { type: 'error', message } if the detector
// cannot be built or throws.
// Accepts { type: 'pause', paused } and { type: 'stop' }.
import { IMPLS } from './kernels.js';
import { createResampler } from './resample.js';

const clock = globalThis.performance?.now ? () => globalThis.performance.now() : () => Date.now(); // some worklet scopes lack performance
const STATS_SECONDS = 0.5;

class PitchPleaseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.alive = true;
    this.paused = false;
    this.busyMs = 0; this.samples = 0; this.frames = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'pause') this.paused = e.data.paused;
      else if (e.data.type === 'stop') this.alive = false;
    };
    try {
      const { manifest, weights, impl, wasmBytes } = options.processorOptions;
      const kernel = IMPLS[impl];
      if (!kernel) throw new Error(`kernel '${impl}' is not in this worklet build`);
      // The kernel resamples 48 kHz itself and takes 22.05 kHz directly; any other context rate is resampled here.
      const direct = sampleRate === 48000 || sampleRate === 22050;
      this.resampler = direct ? null : createResampler(sampleRate, 22050);
      this.det = kernel.createDetector(kernel.parseWeights(manifest, weights), { inputRate: direct ? sampleRate : 22050, wasmModule: wasmBytes });
      this.port.postMessage({ type: 'ready', version: '__PITCHPLEASE_VERSION__' });
    } catch (e) {
      this.alive = false;
      this.port.postMessage({ type: 'error', message: String(e && e.message || e) });
    }
  }

  process(inputs) {
    if (!this.alive) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch || this.paused) return true;
    const t0 = clock();
    let out;
    try {
      out = this.det.push(this.resampler ? this.resampler.push(ch) : ch);
    } catch (e) {
      this.alive = false;
      this.port.postMessage({ type: 'error', message: String(e && e.message || e) });
      return false;
    }
    this.busyMs += clock() - t0;
    for (const f of out) {
      const probs = Float32Array.from(f.probs); // own copy: a WASM kernel's probs may view its memory
      this.port.postMessage({ type: 'frame', t: f.t, emit: f.emit, probs }, [probs.buffer]);
    }
    this.frames += out.length;
    this.samples += ch.length;
    if (this.samples >= STATS_SECONDS * sampleRate) {
      const seconds = this.samples / sampleRate;
      this.port.postMessage({ type: 'stats', cpuLoad: this.busyMs / (seconds * 1000), framesPerSecond: this.frames / seconds });
      this.busyMs = 0; this.samples = 0; this.frames = 0;
    }
    return true;
  }
}

registerProcessor('pitchplease', PitchPleaseProcessor);
