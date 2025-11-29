# PitchPlease

Polyphonic pitch detection in the browser. No dependencies, no build step.

## Features

- Real-time polyphonic pitch detection via Web Audio API
- Chord recognition (24 chord types including 7ths, 6ths, extensions)
- Colorful spectrum visualization
- Adjustable MIDI range
- ~300 lines of vanilla JS

## Usage

```html
<script src="pitchplease.js"></script>
<script>
  const p = PitchPlease.create({
    onUpdate: (data) => { /* spectrum, detected notes, chord */ },
    onChord: (chord) => console.log(chord.full), // "Cmaj7"
    onError: (e) => console.error(e)
  });

  button.onclick = () => p.start();
</script>
```

## Dev

```bash
bun dev-testing.js
# open http://localhost:3000
```

## API

### `PitchPlease.create(options)`

Returns `{ start, stop, togglePause, paused }`.

**Options:**
- `onUpdate(data)` - called each frame with detection data
- `onChord(chord)` - called when a stable chord is detected
- `onError(error)` - called on errors
- `fftSize` - FFT size (default: 16384)
- `stabilityFrames` - frames before chord is considered stable (default: 4)

### Detection Data

```javascript
{
  spectrum,      // Float32Array - FFT magnitudes
  binMidi,       // Float32Array - MIDI note for each bin
  fundMidis,     // Float32Array - detected fundamental pitches
  fundCount,     // number of detected pitches
  pitchClasses,  // array of pitch classes [0-11]
  stable,        // boolean - detection is stable
  chord,         // { root, abbrev, full } or null
  maxEnergy,     // max FFT magnitude this frame
}
```

### Chord Types

Triads: Major, Minor, Dim, Aug, Sus4, Sus2, 5
Sevenths: Maj7, 7, m7, m(maj7), dim7, ø7, aug7
Sixths: 6, m6
Extensions: add9, madd9, 9, m9, maj9, 11, 13
