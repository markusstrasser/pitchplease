const PitchPlease = require('../pitchplease.js');
const { matchChord, midiToNote, NOTE_NAMES } = PitchPlease;

describe('matchChord', () => {
  // Should return null for insufficient notes
  test('returns null for single pitch class', () => {
    expect(matchChord([0])).toBeNull();
    expect(matchChord([5])).toBeNull();
  });

  test('returns null for two pitch classes', () => {
    expect(matchChord([0, 4])).toBeNull();
    expect(matchChord([9, 8])).toBeNull(); // A, G# - was falsely matching maj7
  });

  test('returns null for empty/invalid input', () => {
    expect(matchChord([])).toBeNull();
    expect(matchChord(null)).toBeNull();
    expect(matchChord(undefined)).toBeNull();
  });

  // Triads - should match correctly
  test('matches C major (C, E, G)', () => {
    const chord = matchChord([0, 4, 7]);
    expect(chord.root).toBe('C');
    expect(chord.abbrev).toBe('');
    expect(chord.full).toBe('C');
  });

  test('matches A minor (A, C, E)', () => {
    const chord = matchChord([9, 0, 4]);
    expect(chord.root).toBe('A');
    expect(chord.abbrev).toBe('m');
    expect(chord.full).toBe('Am');
  });

  test('matches D minor (D, F, A)', () => {
    const chord = matchChord([2, 5, 9]);
    expect(chord.root).toBe('D');
    expect(chord.abbrev).toBe('m');
    expect(chord.full).toBe('Dm');
  });

  test('matches G major (G, B, D)', () => {
    const chord = matchChord([7, 11, 2]);
    expect(chord.root).toBe('G');
    expect(chord.abbrev).toBe('');
    expect(chord.full).toBe('G');
  });

  test('matches F# diminished (F#, A, C)', () => {
    const chord = matchChord([6, 9, 0]);
    expect(chord.root).toBe('F#');
    expect(chord.abbrev).toBe('dim');
  });

  test('matches C augmented (C, E, G#)', () => {
    const chord = matchChord([0, 4, 8]);
    expect(chord.root).toBe('C');
    expect(chord.abbrev).toBe('aug');
  });

  test('matches Fsus4 (F, Bb, C)', () => {
    const chord = matchChord([5, 10, 0]);
    expect(chord.root).toBe('F');
    expect(chord.abbrev).toBe('sus4');
  });

  test('matches Dsus2 (D, E, A)', () => {
    const chord = matchChord([2, 4, 9]);
    expect(chord.root).toBe('D');
    expect(chord.abbrev).toBe('sus2');
  });

  // Seventh chords
  test('matches Cmaj7 (C, E, G, B)', () => {
    const chord = matchChord([0, 4, 7, 11]);
    expect(chord.root).toBe('C');
    expect(chord.abbrev).toBe('maj7');
    expect(chord.full).toBe('Cmaj7');
  });

  test('matches G7 (G, B, D, F)', () => {
    const chord = matchChord([7, 11, 2, 5]);
    expect(chord.root).toBe('G');
    expect(chord.abbrev).toBe('7');
    expect(chord.full).toBe('G7');
  });

  test('matches Am7 or C6 (A, C, E, G) - ambiguous', () => {
    const chord = matchChord([9, 0, 4, 7]);
    // Am7 and C6 have same notes - either interpretation is valid
    expect(['Am7', 'C6']).toContain(chord.full);
  });

  test('matches Bdim7 or Ddim7 (B, D, F, Ab) - symmetric chord', () => {
    const chord = matchChord([11, 2, 5, 8]);
    // Dim7 is symmetric - any note can be root
    expect(chord.abbrev).toBe('dim7');
  });

  // Inversions should still work
  test('matches chord regardless of input order', () => {
    const c1 = matchChord([0, 4, 7]);  // C, E, G
    const c2 = matchChord([4, 7, 0]);  // E, G, C
    const c3 = matchChord([7, 0, 4]);  // G, C, E
    expect(c1.full).toBe('C');
    expect(c2.full).toBe('C');
    expect(c3.full).toBe('C');
  });

  // Duplicates should be handled
  test('handles duplicate pitch classes', () => {
    const chord = matchChord([0, 0, 4, 4, 7, 7]);
    expect(chord.root).toBe('C');
    expect(chord.full).toBe('C');
  });
});

describe('midiToNote', () => {
  test('converts MIDI 60 to C', () => {
    expect(midiToNote(60)).toBe('C');
  });

  test('converts MIDI 60 with octave to C4', () => {
    expect(midiToNote(60, true)).toBe('C4');
  });

  test('converts MIDI 69 to A', () => {
    expect(midiToNote(69)).toBe('A');
  });

  test('converts MIDI 69 with octave to A4', () => {
    expect(midiToNote(69, true)).toBe('A4');
  });

  test('converts MIDI 48 to C3', () => {
    expect(midiToNote(48, true)).toBe('C3');
  });

  test('converts sharps correctly', () => {
    expect(midiToNote(61)).toBe('C#');
    expect(midiToNote(66)).toBe('F#');
  });
});

describe('NOTE_NAMES', () => {
  test('has 12 note names', () => {
    expect(NOTE_NAMES.length).toBe(12);
  });

  test('starts with C', () => {
    expect(NOTE_NAMES[0]).toBe('C');
  });

  test('contains all chromatic notes', () => {
    expect(NOTE_NAMES).toEqual(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
  });
});
