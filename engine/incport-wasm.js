// Vendored from pitchtest web/incport-wasm.js @ 78a3dd1. Do not edit here: change it upstream, then node scripts/vendor.mjs incport-wasm.js
// WASM-SIMD variant of web/incport.js (same API and frame output). The CQT column dot products, the
// frequency-domain G x U product and the whole head (c1 -> cr -> c2(+s2) -> c3) run in web/incport.wasm
// (built by web/wasm/build.sh; raw module, no imports). Orchestration, FFTs, octaves and resampler stay JS.
//
//   const wasmModule = await loadWasm(new URL('./incport.wasm', import.meta.url));   // Node: a path works too
//   const det = createDetector(weights, {inputRate: 48000, wasmModule});  // wasmModule: WebAssembly.Module or bytes
//
// Inside an AudioWorklet: compile on the main thread, post the WebAssembly.Module via processorOptions, then
// createDetector(...) instantiates it synchronously (one instance per detector; state lives in its memory).
//
// Original header (incport.js):
// Streaming basic-pitch (fine-tuned head R-T-L2-OW-w10L-s0) — dependency-free JS port of
// pitchtest/bpport.py::IncPort as driven by pitchtest/detectors.py::BPPortStream
// (lookahead=2, hop=1, cqt_delay=0, refresh=8). The Python is the specification.
//
//   const det = createDetector(weights, {inputRate: 48000});   // or 22050 (bypasses the resampler)
//   const frames = det.push(float32Chunk);                     // [{t, emit, probs: Float32Array(88)}]
//
// weights: {tensors: {name: Float32Array}, const: {...}} from loadWeights (manifest.json + weights.bin).
// Internal state is Float64Array (JS arithmetic is double anyway; matches numpy float64).

export function parseWeights(manifest, buffer) {
  const all = new Float32Array(buffer);
  const tensors = {};
  for (const [k, m] of Object.entries(manifest.tensors)) {
    const n = m.shape.reduce((a, b) => a * b, 1);
    tensors[k] = all.subarray(m.offset, m.offset + n);
  }
  return { tensors, shapes: Object.fromEntries(Object.entries(manifest.tensors).map(([k, m]) => [k, m.shape])), const: manifest.const };
}

const SR = 22050, HOP = 256, WIN = 43844, N_OCT = 9, N_BINS = 309, NFFT = 512, NB = 257;
const SHIFTS = [-36, 0, 36, 57, 72, 84, 93, 101];
const END_OFF = [68, 34, 17, 8, 4, 2, 1, 0, 0];
const SR_IN = 48000, QUANTUM = 128, RESAMPLER_DELAY = 48 / SR_IN;
const RING = 256; // frame-indexed rings (>= 172 rows of min/max)

// ---------------------------------------------------------------- FFT (complex radix-2, in place)
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  // sign=-1 forward, +1 inverse (unscaled)
  return function fft(re, im, sign) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = sign * sin[k];
          const a = s + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

// ---------------------------------------------------------------- streaming resampler 48k -> 22.05k
// Windowed-sinc (Kaiser beta 8.6, +-48 input taps = 96-tap FIR at 48 kHz, 1 ms group delay as RESAMPLER_DELAY),
// cutoff 0.92 * 11025 Hz. Output n is the band-limited value at input time n*320/147; it is produced once input
// sample floor(p)+48 has arrived. Zero history before the stream (as soxr's zero padding).
function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }
export function createResampler() {
  const H = 48, TAPS = 2 * H, UP = 147, DOWN = 320, beta = 8.6, fc = 0.92 * 11025 / SR_IN;
  const table = new Float64Array(UP * TAPS); // phase q: frac = q/147; taps for input k = floor(p) - H + 1 + m
  const i0b = bessel0(beta);
  for (let q = 0; q < UP; q++) {
    const frac = q / UP;
    let sum = 0;
    for (let m = 0; m < TAPS; m++) {
      const d = (m - H + 1) - frac; // input offset relative to p
      const w = Math.abs(d) >= H ? 0 : bessel0(beta * Math.sqrt(1 - (d / H) ** 2)) / i0b;
      const x = 2 * fc * d;
      const s = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      table[q * TAPS + m] = 2 * fc * s * w;
      sum += table[q * TAPS + m];
    }
    for (let m = 0; m < TAPS; m++) table[q * TAPS + m] /= sum; // unity DC gain per phase
  }
  let hist = new Float64Array(1 << 14), base = -TAPS, len = TAPS; // hist[i] = input sample (base + i); zeros before 0
  let nIn = 0, nOut = 0;
  return {
    push(x) { // returns Float32Array of new output samples
      if (len + x.length > hist.length) {
        const keep = TAPS + 4; const drop = len - keep;
        hist.copyWithin(0, drop, len); base += drop; len = keep;
        if (len + x.length > hist.length) { const h2 = new Float64Array(2 * (len + x.length)); h2.set(hist.subarray(0, len)); hist = h2; }
      }
      for (let i = 0; i < x.length; i++) hist[len++] = x[i];
      nIn += x.length;
      const out = [];
      for (;;) {
        const num = nOut * DOWN, ip = Math.floor(num / UP), q = num - ip * UP;
        const k0 = ip - H + 1; // first input index
        if (k0 + TAPS - 1 >= nIn) break;
        let acc = 0; const off = k0 - base, tq = q * TAPS;
        for (let m = 0; m < TAPS; m++) acc += hist[off + m] * table[tq + m];
        out.push(acc); nOut++;
      }
      return Float32Array.from(out);
    },
  };
}

// ---------------------------------------------------------------- wasm loading
// Two builds of the same kernels: incport.wasm (+simd128) and incport-relaxed.wasm (+relaxed-simd: f32x4.relaxed_madd).
// hasRelaxedSimd() validates a tiny probe module containing one f32x4.relaxed_madd (Safari lacks relaxed SIMD).
const V128C = [0xfd, 0x0c, ...new Array(16).fill(0)];
const PROBE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7b, 3, 2, 1, 0,
  0x0a, 61, 1, 59, 0, ...V128C, ...V128C, ...V128C, 0xfd, 0x85, 0x02, 0x0b]);
export function hasRelaxedSimd() { try { return WebAssembly.validate(PROBE); } catch { return false; } }
export function wasmFileName(relaxed = hasRelaxedSimd()) { return relaxed ? 'incport-relaxed.wasm' : 'incport.wasm'; }
// Default source: the build this engine supports, next to this module.
export const defaultWasmUrl = () => (hasRelaxedSimd() ? new URL('./incport-relaxed.wasm', import.meta.url) : new URL('./incport.wasm', import.meta.url));
// loadWasm(urlOrPathOrBytes) -> Promise<WebAssembly.Module>. URL/string: fetch in browsers, fs in Node.
export async function loadWasm(src = defaultWasmUrl()) {
  if (src instanceof URL && src.protocol === 'file:') src = src.pathname;
  if (src instanceof WebAssembly.Module) return src;
  if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) return new WebAssembly.Module(src);
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (isNode && !(typeof src === 'string' && /^https?:/.test(src)) && !(src instanceof URL && /^https?:/.test(src.protocol))) {
    const { readFileSync } = globalThis.process.getBuiltinModule('node:fs');
    return new WebAssembly.Module(readFileSync(src));
  }
  return WebAssembly.compile(await (await fetch(src)).arrayBuffer());
}
function instantiate(m) {
  if (!m) throw new Error('createDetector: opts.wasmModule (WebAssembly.Module or bytes) is required; see loadWasm()');
  if (!(m instanceof WebAssembly.Module)) m = new WebAssembly.Module(m);
  return new WebAssembly.Instance(m, {}).exports;
}
const NBP = 258; // wasm bin stride (257 padded)

// ---------------------------------------------------------------- detector
export function createDetector(weights, opts = {}) {
  const X = instantiate(opts.wasmModule);
  const mem = X.memory.buffer;
  const v64 = (ptr, n) => new Float64Array(mem, ptr, n), v32 = (ptr, n) => new Float32Array(mem, ptr, n);
  const inputRate = opts.inputRate ?? 48000;
  const W = weights.tensors;
  const L = 2, HOPF = 1, D = 0, R = 8;
  const bnMul = W.bn_mul[0], bnAdd = W.bn_add[0];
  v64(X.ka_ptr(), 36 * 256).set(W.cqt_a); v64(X.kb_ptr(), 36 * 256).set(W.cqt_b);
  const wSeg = v64(X.seg_ptr(), 9 * 256), raw = v64(X.raw_ptr(), N_OCT * 72);
  const lowpass = Float64Array.from(W.lowpass);
  const scale = Float64Array.from(W.cqt_scale);
  { const gr = v64(X.gre_ptr(), 192 * NBP), gi = v64(X.gim_ptr(), 192 * NBP);
    for (let r = 0; r < 192; r++) for (let k = 0; k < NB; k++) { gr[r * NBP + k] = W.G_re[r * NB + k]; gi[r * NBP + k] = W.G_im[r * NB + k]; } }
  const Qk = Float64Array.from(W.Qk);
  v64(X.c1b_ptr(), 8).set(W.c1_b); v32(X.crw_ptr(), 200).set(W.cr_w); v32(X.c2w_ptr(), 32 * 49).set(W.c2_w);
  v32(X.c2b_ptr(), 32).set(W.c2_b); v32(X.c3w_ptr(), 32 * 21).set(W.c3_w);
  // optional side conv s2 (head bp8): c2 = relu(conv_c2(contour) + conv_s2(relu(c1))), (32, 8, 7, 7)
  const s2W = W.s2_w ?? null;
  if (s2W && s2W.length !== 32 * 8 * 49) throw new Error('s2_w must be (32, 8, 7, 7)');
  if (s2W) { v32(X.s2w_ptr(), 32 * 8 * 49).set(s2W); v32(X.s2b_ptr(), 32).set(W.s2_b); }
  X.init(s2W ? 1 : 0, W.cr_b[0], W.c3_b[0]);
  const slots = new Int32Array(mem, X.slots_ptr(), 16), wProbs = v64(X.probs_ptr(), 88);
  const fft = makeFFT(NFFT);
  const resampler = inputRate === SR ? null : createResampler();

  // octave signals: oct[o][i - obase[o]] = sample i of octave o (octave 0 = z = WIN zeros + audio)
  const oct = [], obase = new Float64Array(N_OCT), ocap = [];
  for (let o = 0; o < N_OCT; o++) { const cap = o === 0 ? 1 << 17 : (1 << 17) >> o > 4096 ? (1 << 17) >> o : 4096; oct.push(new Float64Array(cap)); ocap.push(cap); }
  const nfin = new Float64Array(N_OCT); // n_fin per octave (octave 0 unused)
  let nY = 0; // 22.05 kHz samples received
  let nextE = HOP; // next e at which a call happens
  let nIn48 = 0;
  let last = null;

  // rings
  const lpMin = new Float64Array(RING), lpMax = new Float64Array(RING);
  const RP = 128; // P/Q ring (rows Fp-64 .. Fp+1 live)
  const P = v64(X.p_ptr(), RP * 8 * 264), Q = v64(X.q_ptr(), RP * 8 * 264), pKey = new Float64Array(RP).fill(-1e9), qKey = new Float64Array(RP).fill(-1e9);
  const RT = 16; const taps = new Float64Array(RT * 3 * 8 * 264), tKey = new Float64Array(RT).fill(-1e9);
  let macs = 0;

  // scratch
  const lp = new Float64Array(N_BINS);
  const u = new Float64Array(8 * 264);
  const Ure = v64(X.ure_ptr(), 8 * NBP), Uim = v64(X.uim_ptr(), 8 * NBP), Are = v64(X.are_ptr(), 24 * NBP), Aim = v64(X.aim_ptr(), 24 * NBP);
  const fr = new Float64Array(NFFT), fi = new Float64Array(NFFT);
  const newTaps = new Float64Array(3 * 8 * 264);
  const ROW_MACS = weights.const?.row_macs ?? 0;
  const COL_MACS = N_OCT * 72 * 256;

  function octStore(o, i, v) { oct[o][i - obase[o]] = v; }
  function ensure(o, endIdx, keepFrom) { // make room for indices up to endIdx, drop below keepFrom
    const a = oct[o];
    if (endIdx - obase[o] <= a.length) return;
    const drop = Math.max(0, Math.floor(keepFrom - obase[o]));
    if (drop > 0) { a.copyWithin(0, drop); obase[o] += drop; }
    if (endIdx - obase[o] > a.length) { const b = new Float64Array(2 * (endIdx - obase[o])); b.set(a); oct[o] = b; }
  }

  function octaves(F) { // StreamPort._octaves; returns E per octave
    const E = new Array(N_OCT);
    for (let o = 0; o < N_OCT; o++) E[o] = Math.floor(F * 256 / 2 ** o) + END_OFF[o];
    let finLen = E[0];
    for (let o = 0; o < N_OCT - 1; o++) {
      const j0 = nfin[o + 1], jEnd = E[o + 1], srcLen = E[o], src = oct[o], sb = obase[o];
      if (jEnd > j0) {
        ensure(o + 1, jEnd, jEnd - 8192);
        const dst = oct[o + 1], db = obase[o + 1];
        for (let j = j0; j < jEnd; j++) {
          let acc = 0; const s0 = 2 * j - 127;
          const kLo = Math.max(0, -s0), kHi = Math.min(256, srcLen - s0);
          for (let k = kLo; k < kHi; k++) acc += src[s0 + k - sb] * lowpass[k];
          dst[j - db] = acc;
        }
        macs += (jEnd - j0) * 256;
      }
      nfin[o + 1] = Math.max(j0, Math.min(jEnd, Math.floor((finLen - 129) / 2) + 1));
      finLen = nfin[o + 1];
    }
    return E;
  }

  function column(E, f, out) { // StreamPort._columns for one frame -> log power (309)
    for (let o = N_OCT - 1; o >= 0; o--) {
      const s = oct[o], sb = obase[o], e = E[o], c = Math.floor(f * 256 / 2 ** o), so = o * 256;
      for (let k = 0; k < 256; k++) {
        let idx = c + k - 128;
        if (idx >= e) idx = 2 * (e - 1) - idx;
        wSeg[so + k] = idx >= 0 ? s[idx - sb] : 0;
      }
    }
    X.cqt();
    const skip = N_OCT * 36 - N_BINS;
    for (let i = 0; i < N_BINS; i++) {
      const re = raw[2 * (i + skip)] * scale[i], im = raw[2 * (i + skip) + 1] * scale[i];
      out[i] = 10 * Math.log10(re * re + im * im + 1e-10);
    }
    macs += COL_MACS;
  }

  function slotP(t) { // P/Q.get(t, 0) — zero a ring slot on first touch
    const s = ((t % RP) + RP) % RP;
    if (pKey[s] !== t) { pKey[s] = t; P.fill(0, s * 2112, (s + 1) * 2112); }
    return s * 2112;
  }
  function slotQ(t) {
    const s = ((t % RP) + RP) % RP;
    if (qKey[s] !== t) { qKey[s] = t; Q.fill(0, s * 2112, (s + 1) * 2112); }
    return s * 2112;
  }

  function addRow(f, lpRow) { // IncPort._add_row
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < N_BINS; i++) { const v = lpRow[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const rs = ((f % RING) + RING) % RING; lpMin[rs] = mn; lpMax[rs] = mx;
    // stack -> u (8, 264)
    for (let c = 0; c < 8; c++) { const s = SHIFTS[c]; for (let j = 0; j < 264; j++) { const k = j + s; u[c * 264 + j] = k >= 0 && k < N_BINS ? lpRow[k] : 0; } }
    // rfft of 8 inputs, two per complex FFT
    for (let p = 0; p < 4; p++) {
      fr.fill(0); fi.fill(0);
      for (let j = 0; j < 264; j++) { fr[j] = u[(2 * p) * 264 + j]; fi[j] = u[(2 * p + 1) * 264 + j]; }
      fft(fr, fi, -1);
      for (let k = 0; k < NB; k++) {
        const nk = (NFFT - k) & (NFFT - 1);
        const zr = fr[k], zi = fi[k], cr_ = fr[nk], ci = -fi[nk]; // conj(Z[N-k])
        Ure[(2 * p) * NBP + k] = 0.5 * (zr + cr_); Uim[(2 * p) * NBP + k] = 0.5 * (zi + ci);
        // (Z - conj)/(2i) = (dr + i di)/(2i) = di/2 - i dr/2
        const dr = zr - cr_, di = zi - ci;
        Ure[(2 * p + 1) * NBP + k] = 0.5 * di; Uim[(2 * p + 1) * NBP + k] = -0.5 * dr;
      }
    }
    // taps[kt][o] = irfft(sum_i G[o,i,kt] U_i)[:264]; two outputs per complex IFFT
    X.gmul(); // A[kt][o][k] = sum_i G[o,i,kt] U_i (DC/Nyquist imag zeroed)
    for (let kt = 0; kt < 3; kt++) {
      for (let op = 0; op < 4; op++) {
        const a0 = (kt * 8 + 2 * op) * NBP, b0_ = a0 + NBP;
        // Z[k] = A[k] + i B[k] with Hermitian extension; ifft -> a + i b
        for (let k = 0; k < NFFT; k++) {
          let Ar, Ai, Br, Bi;
          if (k < NB) { Ar = Are[a0 + k]; Ai = Aim[a0 + k]; Br = Are[b0_ + k]; Bi = Aim[b0_ + k]; }
          else { const m = NFFT - k; Ar = Are[a0 + m]; Ai = -Aim[a0 + m]; Br = Are[b0_ + m]; Bi = -Aim[b0_ + m]; }
          fr[k] = Ar - Bi; fi[k] = Ai + Br;
        }
        fft(fr, fi, 1);
        const b0 = (kt * 8 + 2 * op) * 264, b1 = b0 + 264;
        for (let j = 0; j < 264; j++) { newTaps[b0 + j] = fr[j] / NFFT; newTaps[b1 + j] = fi[j] / NFFT; }
      }
    }
    const ts = ((f % RT) + RT) % RT, hasOld = tKey[ts] === f, ob = ts * 6336;
    for (let kt = 0; kt < 3; kt++) {
      const t = f - kt + 1, pb = slotP(t), nb = kt * 2112;
      if (!hasOld) {
        const qb = slotQ(t);
        for (let i = 0; i < 2112; i++) { P[pb + i] += newTaps[nb + i]; Q[qb + i] += Qk[nb + i]; }
      } else {
        for (let i = 0; i < 2112; i++) P[pb + i] += newTaps[nb + i] - taps[ob + nb + i];
      }
    }
    tKey[ts] = f; taps.set(newTaps, ob);
    macs += ROW_MACS;
  }


  function call(F) { // IncPort.call; returns {frame, probs}
    const Fp = F - D;
    const E = octaves(F);
    const lo = Fp - 171;
    const start = last === null ? lo : Math.max(lo, Math.min(last + 1, Fp - R + 1));
    if (Fp >= start) {
      for (let f = start; f <= Fp; f++) { column(E, f, lp); addRow(f, lp); }
      last = Fp;
    }
    for (let s = 0; s < RT; s++) if (tKey[s] <= Fp - R) tKey[s] = -1e9;
    let mn = Infinity, mx = -Infinity;
    for (let f = lo; f <= Fp; f++) { const s = ((f % RING) + RING) % RING; if (lpMin[s] < mn) mn = lpMin[s]; if (lpMax[s] > mx) mx = lpMax[s]; }
    const a = mx > mn ? bnMul / (mx - mn) : 0, b = bnAdd - mn * a;
    const tLo = F - L - HOPF + 1; // == tHi (hop 1)
    // Head on zero-padded buffers (rows beyond Fp and frequencies outside the map are 0, as the
    // Python's pad_time / pad_f), so the inner loops carry no bounds checks. hop=1, D=0: fixed row counts.
    const rLo = tLo - 8; // c1 rows F-10..F (11); cr 9 rows; c2 6 rows; c3 -> 88 (all in wasm, see lib.rs head)
    for (let r = 0; r < 11; r++) { const pb = slotP(rLo + r), qb = slotQ(rLo + r); if (pb !== qb) throw new Error('P/Q slot mismatch'); slots[r] = pb; }
    X.head(a, b);
    const probs = Float32Array.from(wProbs);
    macs += 8 * 11 * 264 * 2 + 9 * 8 * 25 * 264 + 6 * 32 * 49 * 88 + (s2W ? 6 * 32 * 8 * 49 * 88 : 0) + 32 * 21 * 88;
    return { frame: tLo, probs };
  }

  function feed22(y, emitOverride) {
    const out = [];
    // append to octave 0 (index WIN + nY)
    ensure(0, WIN + nY + y.length, WIN + nY - 8192);
    const z = oct[0], zb = obase[0];
    for (let i = 0; i < y.length; i++) z[WIN + nY + i - zb] = y[i];
    nY += y.length;
    while (nextE <= nY) {
      const e = nextE; nextE += HOP * HOPF;
      const F = Math.floor(e / HOP) + 171;
      const { frame, probs } = call(F);
      const t = (frame * HOP - WIN) / SR;
      if (t < 0) continue;
      const emit = emitOverride ?? Math.ceil((((e - 1) / SR + RESAMPLER_DELAY) * SR_IN) / QUANTUM - 1e-9) * QUANTUM / SR_IN;
      out.push({ t, emit, probs });
    }
    return out;
  }

  return {
    push(x) {
      if (!resampler) return feed22(x);
      nIn48 += x.length;
      return feed22(resampler.push(x), nIn48 / SR_IN); // emit = end of the delivering chunk (true availability)
    },
    get macs() { return macs; },
    get samples22() { return nY; },
  };
}
