// model: 'fft' must behave exactly as v2. v2's own pitchplease.js (tests/fixtures/pitchplease-v2.js, from 365f53f)
// and v3 run side by side on the same scripted spectra, clock and animation frames; every onUpdate payload and every
// chord event must match, through a pause and a resume.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createAnalyserEmulator } from '../engine/fft.js';
import * as P from '../pitchplease.js';
import { installBrowser } from './helpers/browser.js';

const V2_SRC = readFileSync(new URL('./fixtures/pitchplease-v2.js', import.meta.url), 'utf8');
const SR = 48000, FPS = 60, HOP = SR / FPS;

// 5 s of harmonic tones: silence, C major, A minor, G3 alone, noise, F major, silence (0.6 s each, decaying).
function signal() {
  const seg = 0.6 * SR, parts = [[], [60, 64, 67], [57, 60, 64], [55], 'noise', [53, 57, 60], []];
  const x = new Float32Array(parts.length * seg);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  parts.forEach((p, s) => {
    for (let i = 0; i < seg; i++) {
      const t = i / SR, env = Math.exp(-2 * t);
      let v = 0;
      if (p === 'noise') v = 0.2 * rand();
      else for (const m of p) { const f = 440 * 2 ** ((m - 69) / 12); for (let h = 1; h <= 6; h++) v += 0.08 * env * Math.sin(2 * Math.PI * f * h * t) / h; }
      x[s * seg + i] = v + 0.001 * rand();
    }
  });
  return x;
}

let env, frames, current = null;
beforeAll(() => {
  const x = signal(), emu = createAnalyserEmulator(16384);
  frames = [];
  for (let i = 0; Math.round(i * HOP) <= x.length; i++) frames.push(Uint8Array.from(emu.frequencyData(x, Math.round(i * HOP))));
  env = installBrowser({ spectrum: () => current });
});
afterAll(() => env.restore());

function loadV2(raf) {
  const module = { exports: {} };
  new Function('window', 'navigator', 'performance', 'requestAnimationFrame', 'module', V2_SRC)(
    { AudioContext: globalThis.AudioContext }, globalThis.navigator, globalThis.performance, raf, module);
  return module.exports;
}

const snap = (d) => ({
  spectrum: Array.from(d.spectrum), binMidi: Array.from(d.binMidi), peakCount: d.peakCount,
  peakBins: Array.from(d.peakBins.subarray(0, d.peakCount)), peakEnergies: Array.from(d.peakEnergies.subarray(0, d.peakCount)),
  fundCount: d.fundCount, fundMidis: Array.from(d.fundMidis.subarray(0, d.fundCount)), pitchClasses: [...d.pitchClasses],
  stable: d.stable, chord: d.chord && { ...d.chord }, maxEnergy: d.maxEnergy, threshold: d.threshold,
});

test('fft model reproduces v2 frame by frame, including pause and resume', async () => {
  const v2raf = new Map();
  let v2id = 0;
  const V2 = loadV2((cb) => { v2raf.set(++v2id, cb); return v2id; });
  const logs = { v2: [], v3: [] };
  const handlers = (log) => ({ onUpdate: (d) => log.push(['update', snap(d)]), onChord: (c) => log.push(['chord', c.full]), onChordEnd: () => log.push(['end']) });
  const d2 = V2.create(handlers(logs.v2));
  const d3 = P.create({ model: 'fft', ...handlers(logs.v3) });
  const notes = [];
  const d3n = P.create({ model: 'fft', onNotes: (n, f) => notes.push([n, f]) });

  current = frames[0]; env.state.clock = 0;
  await d2.start(); await d3.start(); await d3n.start();
  for (let i = 1; i < frames.length; i++) {
    if (i === 150 || i === 170) { d2.togglePause(); d3.togglePause(); d3n.togglePause(); }
    current = frames[i];
    const cbs = [...v2raf.values()]; v2raf.clear();
    for (const cb of cbs) cb(i * 1000 / FPS);
    env.tick(i * 1000 / FPS);
  }
  d2.stop(); d3.stop(); d3n.stop();

  const chords = logs.v2.filter((e) => e[0] === 'chord').map((e) => e[1]);
  expect(chords).toContain('C');
  expect(chords).toContain('Am');
  expect(chords).toContain('F');
  expect(logs.v2.filter((e) => e[0] === 'end').length).toBeGreaterThan(0);
  expect(logs.v2.length).toBeGreaterThan(frames.length - 25); // ~20 paused frames produce nothing
  expect(logs.v3.length).toBe(logs.v2.length);
  for (let i = 0; i < logs.v2.length; i++) expect(logs.v3[i]).toEqual(logs.v2[i]);

  // onNotes: one call per processed frame; notes are the fundamentals, one per key, as { midi, name, pitchClass, prob }
  expect(notes.length).toBe(logs.v2.filter((e) => e[0] === 'update').length);
  const withNotes = notes.filter(([n]) => n.length);
  expect(withNotes.length).toBeGreaterThan(50);
  for (const [n, f] of withNotes) {
    expect(f.probs).toBeNull();
    for (const x of n) {
      expect(Number.isInteger(x.midi)).toBe(true);
      expect(x.pitchClass).toBe(x.midi % 12);
      expect(x.name).toBe(P.midiToNote(x.midi, true));
      expect(x.prob).toBeGreaterThan(0.5);
      expect(x.prob).toBeLessThanOrEqual(1);
    }
    expect(f.pitchClasses).toEqual([...new Set(n.map((x) => x.pitchClass))].sort((a, b) => a - b));
  }
});

test('a pause and resume inside one animation frame does not start a second loop (v2 did)', async () => {
  let frameCount = 0;
  current = frames[60];
  const d = P.create({ model: 'fft', onUpdate: () => frameCount++ });
  await d.start();
  d.togglePause(); d.togglePause(); // resumes before the pending frame fires
  frameCount = 0;
  for (let i = 1; i <= 10; i++) env.tick(10000 + i * 16);
  d.stop();
  expect(frameCount).toBe(10);
});
