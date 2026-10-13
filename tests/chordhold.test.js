const PitchPlease = require('../pitchplease.js');
const { createChordHold } = PitchPlease;

const C = [0, 4, 7];
const Am = [0, 4, 9];

describe('createChordHold', () => {
  test('holds a stable chord and reports it once', () => {
    const h = createChordHold(200);
    expect(h.update(C, false, 0)).toBeNull();
    expect(h.update(C, true, 16)).toBe('chord');
    expect(h.chord.full).toBe('C');
    expect(h.update(C, true, 32)).toBeNull();
  });

  test('bridges a short gap without clearing', () => {
    const h = createChordHold(200);
    h.update(C, true, 0);
    for (let t = 16; t < 200; t += 16) expect(h.update([], true, t)).toBeNull();
    expect(h.chord.full).toBe('C');
    expect(h.update(C, true, 200)).toBeNull();
    expect(h.update([], true, 216)).toBeNull();
    expect(h.chord.full).toBe('C');
  });

  test('clears once after clearAfterMs of silence', () => {
    const h = createChordHold(200);
    h.update(C, true, 0);
    expect(h.update([], true, 16)).toBeNull();
    expect(h.update([], true, 215)).toBeNull();
    expect(h.update([], true, 216)).toBe('clear');
    expect(h.chord).toBeNull();
    expect(h.update([], true, 232)).toBeNull();
  });

  test('the same chord played again after a clear is reported again', () => {
    const h = createChordHold(200);
    h.update(C, true, 0);
    h.update([], true, 100);
    h.update([], true, 300);
    expect(h.update(C, true, 400)).toBe('chord');
  });

  test('another chord replaces the held one without a clear', () => {
    const h = createChordHold(200);
    h.update(C, true, 0);
    expect(h.update(Am, true, 16)).toBe('chord');
    expect(h.chord.full).toBe('Am');
  });

  test('notes that form no chord keep the held chord and are not silence', () => {
    const h = createChordHold(200);
    h.update(C, true, 0);
    expect(h.update([2], true, 16)).toBeNull();
    expect(h.update([2], true, 1000)).toBeNull();
    expect(h.chord.full).toBe('C');
  });

  test('clearAfterMs 0 clears on the first silent frame', () => {
    const h = createChordHold(0);
    h.update(C, true, 0);
    expect(h.update([], true, 16)).toBe('clear');
  });
});
