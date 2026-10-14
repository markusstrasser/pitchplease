// Streaming band-limited resampler for any rate pair: Kaiser-windowed sinc (20 zero crossings each side, beta 8.6,
// cutoff 0.92 of the lower Nyquist), table-interpolated and normalised to unity DC gain per output sample.
// Used only for input rates the kernel does not take directly: the kernel's own resampler handles 48 kHz and
// 22.05 kHz needs none, so the measured (parity-tested) path is untouched.

function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }

export function createResampler(inRate, outRate, { zeros = 20, beta = 8.6, rolloff = 0.92, phases = 256 } = {}) {
  if (!(inRate > 0 && outRate > 0)) throw new RangeError('createResampler: rates must be positive');
  const step = inRate / outRate; // input samples per output sample
  const fc = 0.5 * rolloff * Math.min(1, outRate / inRate); // cutoff in cycles per input sample
  const half = Math.ceil(zeros / (2 * fc)); // filter half-width in input samples
  const n = half * phases + 2;
  const table = new Float64Array(n);
  const i0b = bessel0(beta);
  for (let i = 0; i < n; i++) {
    const d = i / phases;
    const w = d >= half ? 0 : bessel0(beta * Math.sqrt(1 - (d / half) ** 2)) / i0b;
    const x = 2 * fc * d;
    table[i] = w * (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  }
  let hist = new Float64Array(1 << 14), base = -half, len = half; // hist[i] = input sample (base + i); zeros before 0
  let nIn = 0, nOut = 0;
  return {
    /** Seconds of input the resampler must see beyond an output sample before it can produce it. */
    latency: half / inRate,
    push(x) {
      if (len + x.length > hist.length) {
        const keep = 2 * half + 2, drop = len - keep;
        if (drop > 0) { hist.copyWithin(0, drop, len); base += drop; len = keep; }
        if (len + x.length > hist.length) { const h2 = new Float64Array(2 * (len + x.length)); h2.set(hist.subarray(0, len)); hist = h2; }
      }
      for (let i = 0; i < x.length; i++) hist[len++] = x[i];
      nIn += x.length;
      const out = [];
      for (;;) {
        const p = nOut * step, lo = Math.floor(p) - half + 1, hi = Math.floor(p) + half;
        if (hi >= nIn) break;
        let acc = 0, wsum = 0;
        for (let k = lo; k <= hi; k++) {
          const d = Math.abs(p - k) * phases, j = d | 0;
          const w = j >= n - 1 ? 0 : table[j] + (d - j) * (table[j + 1] - table[j]);
          acc += hist[k - base] * w; wsum += w;
        }
        out.push(wsum !== 0 ? acc / wsum : 0);
        nOut++;
      }
      return Float32Array.from(out);
    },
  };
}
