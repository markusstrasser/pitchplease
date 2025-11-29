/**
 * PitchPlease - Polyphonic Pitch Detection v2
 * Single-file, no dependencies, no build step
 *
 * Usage:
 *   const p = PitchPlease.create({ onChord: c => console.log(c.full) });
 *   button.onclick = () => p.start();
 */

(function() {
'use strict';

// ============ MUSIC MATH ============

const C0_HZ = 8.1757989156;
const LOG2 = Math.log(2);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function hzToMidi(hz) {
  return hz > 0 ? 12 * Math.log(hz / C0_HZ) / LOG2 : -1;
}

function midiToHz(midi) {
  return C0_HZ * Math.pow(2, midi / 12);
}

function binToMidi(bin, hzPerBin) {
  return hzToMidi(bin * hzPerBin);
}

function midiToNote(midi, withOctave = false) {
  const m = Math.round(midi);
  if (m < 0) return '';
  const note = NOTE_NAMES[m % 12];
  return withOctave ? `${note}${Math.floor(m / 12) - 1}` : note;
}

function midiToPitchClass(midi) {
  return Math.round(midi) % 12;
}

function pitchClassToColor(pc, s = 80, l = 50, a = 1) {
  const h = (360 - pc * 30 + 60) % 360;
  return `hsla(${h},${s}%,${l}%,${a})`;
}

// ============ CHORD MATCHING ============

const CHORDS = [
  // Triads
  ['Major', '', [4, 7]],
  ['Minor', 'm', [3, 7]],
  ['Dim', 'dim', [3, 6]],
  ['Aug', 'aug', [4, 8]],
  ['Sus4', 'sus4', [5, 7]],
  ['Sus2', 'sus2', [2, 7]],
  ['5', '5', [7]],
  // Sevenths
  ['Maj7', 'maj7', [4, 7, 11]],
  ['7', '7', [4, 7, 10]],
  ['m7', 'm7', [3, 7, 10]],
  ['m(maj7)', 'm(maj7)', [3, 7, 11]],
  ['dim7', 'dim7', [3, 6, 9]],
  ['ø7', 'ø7', [3, 6, 10]],
  ['aug7', 'aug7', [4, 8, 10]],
  // Sixths
  ['6', '6', [4, 7, 9]],
  ['m6', 'm6', [3, 7, 9]],
  // Add/Extensions
  ['add9', 'add9', [2, 4, 7]],
  ['madd9', 'madd9', [2, 3, 7]],
  ['9', '9', [4, 7, 10, 2]],
  ['m9', 'm9', [3, 7, 10, 2]],
  ['maj9', 'maj9', [4, 7, 11, 2]],
  ['11', '11', [4, 7, 10, 2, 5]],
  ['13', '13', [4, 7, 10, 2, 9]],
];

function matchChord(pitchClasses) {
  if (!pitchClasses || pitchClasses.length < 2) return null;

  const pcs = [...new Set(pitchClasses)].sort((a, b) => a - b);
  if (pcs.length < 2) return null;

  let best = null, bestScore = 0.5;

  for (let i = 0; i < pcs.length; i++) {
    const root = pcs[i];
    const intervals = pcs.filter((_, j) => j !== i)
      .map(p => ((p - root) % 12 + 12) % 12)
      .filter(x => x > 0)
      .sort((a, b) => a - b);

    for (const [name, abbrev, template] of CHORDS) {
      let matches = template.filter(t => intervals.includes(t)).length;
      let score = matches / template.length - (intervals.length - matches) * 0.1;

      if (score > bestScore) {
        bestScore = score;
        best = { root: NOTE_NAMES[root], rootPc: root, name, abbrev, full: NOTE_NAMES[root] + abbrev };
      }
    }
  }

  return best;
}

// ============ MAIN ============

function createPolyphon(opts = {}) {
  const config = {
    fftSize: opts.fftSize || 16384,
    binCount: opts.binCount || 500,
    stabilityFrames: opts.stabilityFrames || 4,
    maxPeaks: 64,
    maxFundamentals: 8,
    numHarmonics: 6,
  };

  // Callbacks
  const onUpdate = opts.onUpdate || (() => {});
  const onChord = opts.onChord || (() => {});
  const onError = opts.onError || (e => console.error(e));

  // Audio state
  let audioCtx, analyser, stream;
  let raw, spectrum, binMidi;
  let hzPerBin;

  // Detection state
  let noiseFloor = 0;
  const peakBins = new Float32Array(config.maxPeaks);
  const peakEnergies = new Float32Array(config.maxPeaks);
  const fundMidis = new Float32Array(config.maxFundamentals);
  let peakCount = 0, fundCount = 0;

  // Stability
  const history = [];
  let stable = false;
  let lastChord = null;
  let running = false, paused = false;

  // ---- Audio Setup ----

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });

      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = config.fftSize;
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -80;

      audioCtx.createMediaStreamSource(stream).connect(analyser);

      hzPerBin = audioCtx.sampleRate / config.fftSize;
      raw = new Uint8Array(analyser.frequencyBinCount);
      spectrum = new Float32Array(config.binCount);
      binMidi = new Float32Array(config.binCount);
      for (let i = 0; i < config.binCount; i++) binMidi[i] = binToMidi(i, hzPerBin);

      running = true;
      loop();
    } catch (e) {
      onError(e);
    }
  }

  function stop() {
    running = false;
    stream?.getTracks().forEach(t => t.stop());
    audioCtx?.close();
  }

  function togglePause() {
    paused = !paused;
    if (!paused && running) loop();
    return paused;
  }

  // ---- Main Loop ----

  function loop() {
    if (!running || paused) return;

    analyser.getByteFrequencyData(raw);

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

    // Find fundamentals (harmonic sieve)
    fundCount = 0;
    if (peakCount > 0) {
      const peakMidis = new Float32Array(peakCount);
      const scores = new Float32Array(peakCount);
      const used = new Uint8Array(peakCount);

      for (let i = 0; i < peakCount; i++) peakMidis[i] = binToMidi(peakBins[i], hzPerBin);

      for (let i = 0; i < peakCount; i++) {
        const m = peakMidis[i];
        if (m < 24 || m > 96) continue;
        let s = peakEnergies[i], h = 1;
        for (let n = 2; n <= config.numHarmonics; n++) {
          const exp = m + 12 * Math.log2(n);
          for (let j = 0; j < peakCount; j++) {
            if (j !== i && Math.abs(peakMidis[j] - exp) < 0.5) { s += peakEnergies[j]/n; h++; break; }
          }
        }
        scores[i] = s * Math.sqrt(h);
      }

      let maxS = 0;
      for (let i = 0; i < peakCount; i++) if (scores[i] > maxS) maxS = scores[i];
      if (maxS > 0) for (let i = 0; i < peakCount; i++) scores[i] /= maxS;

      while (fundCount < config.maxFundamentals) {
        let bi = -1, bs = 0.3;
        for (let i = 0; i < peakCount; i++) if (!used[i] && scores[i] > bs) { bs = scores[i]; bi = i; }
        if (bi < 0) break;
        fundMidis[fundCount++] = peakMidis[bi];
        used[bi] = 1;
        const fm = peakMidis[bi];
        for (let n = 2; n <= config.numHarmonics; n++) {
          const exp = fm + 12 * Math.log2(n);
          for (let j = 0; j < peakCount; j++) if (Math.abs(peakMidis[j] - exp) < 0.5) used[j] = 1;
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

    // Chord matching
    if (stable && uniquePcs.length >= 2) {
      const chord = matchChord(uniquePcs);
      if (chord && chord.full !== lastChord?.full) {
        lastChord = chord;
        onChord(chord);
      }
    }

    // Callback
    onUpdate({
      spectrum, binMidi, peakBins, peakEnergies, peakCount,
      fundMidis, fundCount, pitchClasses: uniquePcs, stable,
      chord: lastChord, maxEnergy: maxE, threshold,
    });

    requestAnimationFrame(loop);
  }

  return { start, stop, togglePause, get paused() { return paused; } };
}

// Export
window.PitchPlease = {
  create: createPolyphon,
  matchChord,
  midiToNote,
  pitchClassToColor,
  NOTE_NAMES,
};

})();
