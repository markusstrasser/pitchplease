// The model registry: what each model is for, how it scores, where its weights live, and how they load.
import { PitchPleaseError } from './errors.js';
import { fetchBytes } from './load.js';

// Scores: pitchtest's held-out test sets at each model's operating point. F1 is frame-level note F1; latency is the
// median delay from a note's onset to its first detected frame, counting missed onsets as infinitely late.
// piano = MAESTRO (25 items), guitar = GuitarSet (20), voice = Dagstuhl ChoirSet solo singers (12).
// relativeCost: compute per second of audio relative to 'fast' (multiply-accumulates; the plain-JS kernel's time
// ratio measures the same 2.1x).
export const MODELS = Object.freeze([
  {
    id: 'fast', label: 'Fast', default: true,
    useCase: 'Any device, chords, the safe default. Also the most accurate on unaccompanied singing.',
    sizeKB: 495, relativeCost: 1, latencyMs: 50, pianoF1: 0.679, guitarF1: 0.784, voiceF1: 0.911,
    threshold: { on: 0.7, off: 0.42 },
  },
  {
    id: 'piano', label: 'Piano', default: false,
    useCase: 'Most accurate on piano, strong on guitar, weaker on singing. About twice the compute of fast: wants a fast laptop or desktop until the WASM kernel ships.',
    sizeKB: 545, relativeCost: 2.1, latencyMs: 40, pianoF1: 0.729, guitarF1: 0.818, voiceF1: 0.872,
    threshold: { on: 0.6, off: 0.36 },
  },
  {
    id: 'voice', label: 'Voice', default: false,
    useCase: 'Singing together with instruments: piano and guitar on par with the piano model, sung notes accepted about as well as by fast. Same compute as piano.',
    sizeKB: 545, relativeCost: 2.1, latencyMs: 41, pianoF1: 0.726, guitarF1: 0.821, voiceF1: 0.886,
    threshold: { on: 0.65, off: 0.39 },
  },
  {
    id: 'fft', label: 'FFT (v2)', default: false,
    useCase: 'No model download and the lightest CPU: the v2 FFT peak picker, unchanged. Far less accurate and slower to react.',
    sizeKB: 0, relativeCost: null, latencyMs: 260, pianoF1: 0.375, guitarF1: 0.347, voiceF1: 0.546,
    threshold: null,
  },
].map((m) => Object.freeze({ ...m, threshold: m.threshold && Object.freeze(m.threshold) })));

export const MODEL_IDS = MODELS.map((m) => m.id);

export function getModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new PitchPleaseError('unknown-model', `Unknown model '${id}'. Choose one of: ${MODEL_IDS.join(', ')}.`);
  return m;
}

// Static `new URL('../models/…', import.meta.url)` literals: Vite and webpack 5 emit each file and rewrite the URL.
const DEFAULT_URLS = {
  fast: () => new URL('../models/fast.bin', import.meta.url),
  piano: () => new URL('../models/piano.bin', import.meta.url),
  voice: () => new URL('../models/voice.bin', import.meta.url),
};

/** Where a model's weights are fetched from: `<modelBaseUrl>/<id>.bin`, or the copy shipped in models/. */
export function modelUrl(id, modelBaseUrl) {
  if (!DEFAULT_URLS[id]) throw new PitchPleaseError('unknown-model', `Model '${id}' has no weights file.`);
  if (modelBaseUrl == null) return DEFAULT_URLS[id]();
  let base = typeof modelBaseUrl === 'object' && modelBaseUrl.href ? modelBaseUrl.href : String(modelBaseUrl);
  if (!base.endsWith('/')) base += '/';
  return new URL(`${id}.bin`, new URL(base, globalThis.location?.href));
}

// ---- weights file: "PPW1", u32 LE header length, UTF-8 JSON header, zero padding to 4 bytes, float32 LE tensors.
// header: { model, tensors: { name: { offset (floats), shape } }, const, source }

const MAGIC = 'PPW1';

export function packModel(header, data /* Float32Array */) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = (8 + json.length + 3) & ~3;
  const bytes = new Uint8Array(start + data.byteLength);
  bytes.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(bytes.buffer).setUint32(4, json.length, true);
  bytes.set(json, 8);
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), start);
  return bytes;
}

export function unpackModel(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('not a PitchPlease weights file (bad magic)');
  const n = new DataView(buffer).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
  const start = (8 + n + 3) & ~3;
  const weights = buffer.slice(start);
  return { header, manifest: { tensors: header.tensors, const: header.const }, weights };
}

const cache = new Map(); // url -> Promise<{ header, manifest, weights }>

/** Fetches and unpacks a model's weights once per URL. Rejects with a PitchPleaseError ('model-load-failed'). */
export function loadModel(id, modelBaseUrl) {
  const url = modelUrl(id, modelBaseUrl);
  const key = url.href;
  if (!cache.has(key)) {
    const p = fetchBytes(url).then(unpackModel).catch((e) => {
      cache.delete(key);
      throw new PitchPleaseError('model-load-failed',
        `Could not load the '${id}' model from ${key}: ${e.message}. The package's models/ folder must be served next to engine/; ` +
        `if you host the files elsewhere, set modelBaseUrl to the folder holding fast.bin, piano.bin and voice.bin.`, { cause: e });
    });
    cache.set(key, p);
  }
  return cache.get(key);
}
