// Trained-model frames -> notes and chords. Shared by the live detector and analyze(), so both decode identically.
// Each key is on once its probability rises above `on` and stays on until it falls below `off` (hysteresis, the
// rule pitchtest scores the models with); the held chord is v2's createChordHold, timed by the frame clock.
import { createChordHold, makeNote } from './music.js';

export const KEY_COUNT = 88; // A0 (MIDI 21) .. C8 (MIDI 108)
export const LOWEST_MIDI = 21;

export function createTracker({ on, off, stabilityFrames = 1, clearAfterMs = 200 }) {
  const state = new Uint8Array(KEY_COUNT);
  const history = [];
  const hold = createChordHold(clearAfterMs);
  return {
    // probs: Float32Array(88); time: seconds (stream clock). Returns the frame fields and the chord event.
    step(probs, time) {
      const notes = [];
      let mask = 0;
      for (let k = 0; k < KEY_COUNT; k++) {
        const p = probs[k];
        state[k] = state[k] ? p > off : p > on;
        if (state[k]) {
          const midi = k + LOWEST_MIDI;
          notes.push(makeNote(midi, p));
          mask |= 1 << (midi % 12);
        }
      }
      const pitchClasses = [];
      for (let pc = 0; pc < 12; pc++) if (mask >> pc & 1) pitchClasses.push(pc);
      history.unshift(pitchClasses.join(','));
      if (history.length > stabilityFrames) history.pop();
      const stable = history.length >= stabilityFrames && history.every((h) => h === history[0]);
      const event = hold.update(pitchClasses, stable, time * 1000);
      return { notes, pitchClasses, stable, chord: hold.chord, event };
    },
    get chord() { return hold.chord; },
  };
}
