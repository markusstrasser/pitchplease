// The v2 engine ('fft' model): Web Audio AnalyserNode spectrum -> adaptive noise floor -> peak picking ->
// harmonic sieve -> fundamentals. The per-frame code is v2's loop body unchanged (tests/fft-v2.test.js runs v2's
// pitchplease.js and this engine side by side on the same spectra and requires identical output).
import { createChordHold, makeNote } from './music.js';

const C0_HZ = 8.1757989156;
const LOG2 = Math.log(2);

function hzToMidi(hz) {
  return hz > 0 ? 12 * Math.log(hz / C0_HZ) / LOG2 : -1;
}

function binToMidi(bin, hzPerBin) {
  return hzToMidi(bin * hzPerBin);
}

function midiToPitchClass(midi) {
  return Math.round(midi) % 12;
}

export function fftConfig(opts = {}) {
  return {
    fftSize: opts.fftSize || 16384,
    binCount: opts.binCount || 500,
    stabilityFrames: opts.stabilityFrames || 4,
    clearAfterMs: opts.clearAfterMs ?? 200,
    maxPeaks: 64,
    maxFundamentals: 8,
    numHarmonics: 6,
  };
}

// One analysis stream. step(raw, now): raw = the AnalyserNode's byte spectrum (getByteFrequencyData), now = a ms
// timestamp for the chord hold. Returns { data, event, fundScores }: data has v2's onUpdate fields, event is the chord
// hold's 'chord' | 'clear' | null, fundScores[i] the harmonic score (0.5-1] that accepted fundamental i.
export function createFftAnalysis(config, sampleRate) {
  const hzPerBin = sampleRate / config.fftSize;
  const spectrum = new Float32Array(config.binCount);
  const binMidi = new Float32Array(config.binCount);
  for (let i = 0; i < config.binCount; i++) binMidi[i] = binToMidi(i, hzPerBin);

  let noiseFloor = 0;
  const peakBins = new Float32Array(config.maxPeaks);
  const peakEnergies = new Float32Array(config.maxPeaks);
  const fundMidis = new Float32Array(config.maxFundamentals);
  const fundScores = new Float32Array(config.maxFundamentals);
  let peakCount = 0, fundCount = 0;

  const history = [];
  let stable = false;
  const hold = createChordHold(config.clearAfterMs);

  function step(raw, now) {
    // Update spectrum & find max
    let maxE = 0;
    for (let i = 0; i < config.binCount; i++) {
      spectrum[i] = raw[i];
      if (raw[i] > maxE) maxE = raw[i];
    }

    // Update noise floor
    let sum = 0, cnt = 0;
    for (let i = 0; i < config.binCount; i += 10) {
      if (spectrum[i] < maxE * 0.3) { sum += spectrum[i]; cnt++; }
    }
    noiseFloor = noiseFloor * 0.95 + (cnt ? sum / cnt : 0) * 0.05;
    const threshold = Math.min(255, noiseFloor * 3);

    // Find peaks
    peakCount = 0;
    for (let i = 1; i < config.binCount - 1 && peakCount < config.maxPeaks; i++) {
      const cur = spectrum[i], prev = spectrum[i-1], next = spectrum[i+1];
      if (cur > threshold && cur > prev && cur > next) {
        const d = 2 * (prev - 2*cur + next);
        const off = Math.abs(d) > 0.0001 ? Math.max(-0.5, Math.min(0.5, (prev-next)/d)) : 0;
        peakBins[peakCount] = i + off;
        peakEnergies[peakCount] = cur;
        peakCount++;
      }
    }

    // Find fundamentals (harmonic sieve - stricter like original algorithm)
    fundCount = 0;
    if (peakCount > 0) {
      const peakMidis = new Float32Array(peakCount);
      const harmonicCount = new Uint8Array(peakCount);
      const scores = new Float32Array(peakCount);
      const used = new Uint8Array(peakCount);

      for (let i = 0; i < peakCount; i++) peakMidis[i] = binToMidi(peakBins[i], hzPerBin);

      // Score each peak: must have harmonics to be considered a fundamental
      for (let i = 0; i < peakCount; i++) {
        const m = peakMidis[i];
        if (m < 24 || m > 96) continue;
        let s = peakEnergies[i], h = 1;
        for (let n = 2; n <= config.numHarmonics; n++) {
          const exp = m + 12 * Math.log2(n);
          for (let j = 0; j < peakCount; j++) {
            if (j !== i && Math.abs(peakMidis[j] - exp) < 0.7) { s += peakEnergies[j]/n; h++; break; }
          }
        }
        harmonicCount[i] = h;
        // Require at least 2 harmonics to be a valid fundamental (like original)
        scores[i] = h >= 2 ? s * Math.sqrt(h) : 0;
      }

      let maxS = 0;
      for (let i = 0; i < peakCount; i++) if (scores[i] > maxS) maxS = scores[i];
      if (maxS > 0) for (let i = 0; i < peakCount; i++) scores[i] /= maxS;

      // Only accept fundamentals with score > 0.5 (stricter threshold)
      while (fundCount < config.maxFundamentals) {
        let bi = -1, bs = 0.5;
        for (let i = 0; i < peakCount; i++) if (!used[i] && scores[i] > bs) { bs = scores[i]; bi = i; }
        if (bi < 0) break;
        fundScores[fundCount] = bs;
        fundMidis[fundCount++] = peakMidis[bi];
        used[bi] = 1;
        // Mark all harmonics as used
        const fm = peakMidis[bi];
        for (let n = 2; n <= config.numHarmonics; n++) {
          const exp = fm + 12 * Math.log2(n);
          for (let j = 0; j < peakCount; j++) if (Math.abs(peakMidis[j] - exp) < 0.7) used[j] = 1;
        }
      }
    }

    // Get pitch classes
    const pcs = [];
    for (let i = 0; i < fundCount; i++) pcs.push(midiToPitchClass(fundMidis[i]));
    const uniquePcs = [...new Set(pcs)].sort((a, b) => a - b);

    // Stability check
    history.unshift(uniquePcs.join(','));
    if (history.length > config.stabilityFrames) history.pop();
    stable = history.length >= config.stabilityFrames && history.every(h => h === history[0]);

    // Chord matching (held until another chord matches or clearAfterMs of silence)
    const event = hold.update(uniquePcs, stable, now);

    return {
      event, fundScores,
      data: {
        spectrum, binMidi, peakBins, peakEnergies, peakCount,
        fundMidis, fundCount, pitchClasses: uniquePcs, stable,
        chord: hold.chord, maxEnergy: maxE, threshold,
      },
    };
  }

  return { step, binMidi };
}

/** Notes from one step's fundamentals: one per MIDI key (the best-scoring fundamental), ascending. */
export function fftNotes(data, fundScores) {
  const best = new Map();
  for (let i = 0; i < data.fundCount; i++) {
    const midi = Math.round(data.fundMidis[i]);
    if (!(best.get(midi) >= fundScores[i])) best.set(midi, fundScores[i]);
  }
  return [...best.keys()].sort((a, b) => a - b).map((m) => makeNote(m, best.get(m)));
}

// ============ LIVE (AnalyserNode + requestAnimationFrame, as v2) ============

// onStep(result, nowMs) runs once per animation frame with createFftAnalysis's step result, from begin() on.
export function startFftEngine({ ctx, source, config, onStep }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = config.fftSize;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -80;
  source.connect(analyser);

  const raw = new Uint8Array(analyser.frequencyBinCount);
  const analysis = createFftAnalysis(config, ctx.sampleRate);
  let running = true, paused = false, rafId = 0;
  let busyMs = 0, frames = 0, windowStart = performance.now();
  const stats = { cpuLoad: 0, framesPerSecond: 0 };

  function loop() {
    rafId = 0;
    if (!running || paused) return;
    const t0 = performance.now();
    analyser.getByteFrequencyData(raw);
    const result = analysis.step(raw, t0);
    onStep(result, t0);
    busyMs += performance.now() - t0; frames++;
    if (t0 - windowStart >= 500) {
      const wall = t0 - windowStart;
      stats.cpuLoad = busyMs / wall; stats.framesPerSecond = frames * 1000 / wall;
      busyMs = 0; frames = 0; windowStart = t0;
    }
    rafId = requestAnimationFrame(loop);
  }

  return {
    stats,
    begin() { windowStart = performance.now(); loop(); },
    setPaused(p) {
      paused = p;
      if (paused && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (!paused && running && !rafId) { windowStart = performance.now(); busyMs = 0; frames = 0; loop(); }
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      try { source.disconnect(analyser); } catch {}
    },
  };
}

// ============ OFFLINE (AnalyserNode emulation, for analyze()) ============

// getByteFrequencyData as the Web Audio spec defines it: the last fftSize samples, Blackman window, |FFT| / N,
// smoothing (v2 uses 0), 20 log10, then mapped from [minDecibels, maxDecibels] to 0..255 and floored.
export function createAnalyserEmulator(fftSize, { minDecibels = -80, maxDecibels = -30 } = {}) {
  const levels = Math.log2(fftSize) | 0;
  if (1 << levels !== fftSize) throw new RangeError('fftSize must be a power of two');
  const win = new Float64Array(fftSize);
  for (let n = 0; n < fftSize; n++) win[n] = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / fftSize) + 0.08 * Math.cos(4 * Math.PI * n / fftSize);
  const rev = new Uint32Array(fftSize);
  for (let i = 0; i < fftSize; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  const cos = new Float64Array(fftSize / 2), sin = new Float64Array(fftSize / 2);
  for (let i = 0; i < fftSize / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / fftSize); sin[i] = Math.sin(2 * Math.PI * i / fftSize); }
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const out = new Uint8Array(fftSize / 2);
  const scale = 255 / (maxDecibels - minDecibels);
  return {
    // x: the input signal, end: index one past the last sample the analyser has seen (zeros before 0)
    frequencyData(x, end) {
      for (let n = 0; n < fftSize; n++) { const i = end - fftSize + n; re[rev[n]] = (i >= 0 && i < x.length ? x[i] : 0) * win[n]; }
      im.fill(0);
      for (let size = 2; size <= fftSize; size <<= 1) {
        const half = size >> 1, step = fftSize / size;
        for (let s = 0; s < fftSize; s += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = s + j, b = a + half, wr = cos[k], wi = -sin[k];
            const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          }
        }
      }
      for (let k = 0; k < fftSize / 2; k++) {
        const mag = Math.hypot(re[k], im[k]) / fftSize;
        const db = 20 * Math.log10(mag);
        const v = Math.floor(scale * (db - minDecibels));
        out[k] = v < 0 || Number.isNaN(v) ? 0 : v > 255 ? 255 : v;
      }
      return out;
    },
  };
}

/** Offline v2 analysis at 60 analysis frames per second of audio (v2 ran once per display frame). */
export function analyzeFftOffline(samples, sampleRate, opts, toFrame) {
  const config = fftConfig(opts);
  const analysis = createFftAnalysis(config, sampleRate);
  const emu = createAnalyserEmulator(config.fftSize);
  const hop = sampleRate / 60;
  const frames = [];
  for (let i = 1; Math.round(i * hop) <= samples.length; i++) {
    const end = Math.round(i * hop), time = end / sampleRate;
    const result = analysis.step(emu.frequencyData(samples, end), time * 1000);
    frames.push(toFrame(result, time));
  }
  return frames;
}
