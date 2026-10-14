// Music helpers shared by every engine: note names, chord templates and the held-chord display logic.
// matchChord and createChordHold are v2's code unchanged (pitchtest's scripts/check_pitchplease_port.py ports them).

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToNote(midi, withOctave = false) {
  const m = Math.round(midi);
  if (m < 0) return '';
  const note = NOTE_NAMES[m % 12];
  return withOctave ? `${note}${Math.floor(m / 12) - 1}` : note;
}

export function pitchClassToColor(pc, s = 80, l = 50, a = 1) {
  const h = (360 - pc * 30 + 60) % 360;
  return `hsla(${h},${s}%,${l}%,${a})`;
}

/** A detected note: { midi, name ('C#4'), pitchClass (0-11), prob }. */
export function makeNote(midi, prob) {
  return { midi, name: midiToNote(midi, true), pitchClass: midi % 12, prob };
}

/** Unique pitch classes of notes, ascending. */
export function pitchClassesOf(notes) {
  let mask = 0;
  for (const n of notes) mask |= 1 << n.pitchClass;
  const pcs = [];
  for (let pc = 0; pc < 12; pc++) if (mask >> pc & 1) pcs.push(pc);
  return pcs;
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

export function matchChord(pitchClasses) {
  if (!pitchClasses || pitchClasses.length < 3) return null;

  const pcs = [...new Set(pitchClasses)].sort((a, b) => a - b);
  if (pcs.length < 3) return null;

  // Try each pitch class as potential root (like original algorithm)
  for (let i = 0; i < pcs.length; i++) {
    const root = pcs[i];
    const intervals = pcs.filter((_, j) => j !== i)
      .map(p => ((p - root) % 12 + 12) % 12)
      .filter(x => x > 0)
      .sort((a, b) => a - b);

    // Require EXACT match like original: all template intervals must match, no extras
    for (const [name, abbrev, template] of CHORDS) {
      const sortedTemplate = [...template].sort((a, b) => a - b);
      if (intervals.length === sortedTemplate.length &&
          intervals.every((v, idx) => v === sortedTemplate[idx])) {
        return { root: NOTE_NAMES[root], rootPc: root, name, abbrev, full: NOTE_NAMES[root] + abbrev };
      }
    }
  }

  return null;
}

// Held chord: a matched chord stays until another chord matches, and clears once no pitch class has been heard for
// clearAfterMs, so the display goes blank soon after the sound stops. Gaps inside playing are shorter: 95% of the
// moments with nothing detected last under 80-110 ms in pitchtest's guitar and piano measurements.
export function createChordHold(clearAfterMs = 200) {
  let chord = null, silentSince = null;
  return {
    // pcs: pitch classes heard this frame; stable: the set has held for stabilityFrames; now: a ms timestamp.
    // Returns 'chord' when a new chord is held, 'clear' when the held chord ends, otherwise null.
    update(pcs, stable, now) {
      if (pcs.length) silentSince = null;
      else if (silentSince === null) silentSince = now;
      if (stable && pcs.length >= 2) {
        const c = matchChord(pcs);
        if (c && c.full !== chord?.full) { chord = c; return 'chord'; }
      }
      if (chord && silentSince !== null && now - silentSince >= clearAfterMs) { chord = null; return 'clear'; }
      return null;
    },
    get chord() { return chord; },
  };
}
