# PitchPlease

Polyphonic pitch detection in the browser. No dependencies, no build step.

## Install

Just copy `pitchplease.js` to your project. That's it.

## Usage

### Plain HTML

```html
<script src="pitchplease.js"></script>
<script>
  const detector = PitchPlease.create({
    onUpdate: (data) => console.log(data.pitchClasses),
    onChord: (chord) => console.log(chord.full),  // "Cmaj7"
  });

  // Must be called from user gesture (click/tap)
  button.onclick = () => detector.start();
</script>
```

### Svelte

```svelte
<script>
  import { onMount } from 'svelte';

  let chord = '';
  let detector;

  onMount(() => {
    // Load the script
    const script = document.createElement('script');
    script.src = '/pitchplease.js';
    script.onload = () => {
      detector = PitchPlease.create({
        onChord: (c) => chord = c.full,
      });
    };
    document.head.appendChild(script);
  });

  function start() {
    detector?.start();
  }
</script>

<button on:click={start}>Start</button>
<p>{chord}</p>
```

### React

```jsx
import { useEffect, useRef, useState } from 'react';

export function PitchDetector() {
  const [chord, setChord] = useState('');
  const detector = useRef(null);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = '/pitchplease.js';
    script.onload = () => {
      detector.current = window.PitchPlease.create({
        onChord: (c) => setChord(c.full),
      });
    };
    document.head.appendChild(script);
  }, []);

  return (
    <>
      <button onClick={() => detector.current?.start()}>Start</button>
      <p>{chord}</p>
    </>
  );
}
```

### Node/CommonJS (for testing only - no audio in Node)

```javascript
const PitchPlease = require('./pitchplease.js');
const chord = PitchPlease.matchChord([0, 4, 7]); // { full: 'C' }
```

## API

### `PitchPlease.create(options)`

Creates a detector instance. Returns `{ start, stop, togglePause, paused }`.

```javascript
const detector = PitchPlease.create({
  onUpdate: (data) => {},    // called every frame (~60fps)
  onChord: (chord) => {},    // called when stable chord detected
  onError: (err) => {},      // called on errors
  fftSize: 16384,            // FFT resolution (default: 16384)
  stabilityFrames: 4,        // frames before chord is stable (default: 4)
});

await detector.start();      // request mic, start detection
detector.stop();             // stop and release mic
detector.togglePause();      // pause/resume
detector.paused;             // boolean
```

### `onUpdate` data

```javascript
{
  spectrum,      // Float32Array - raw FFT magnitudes
  binMidi,       // Float32Array - MIDI note for each FFT bin
  fundMidis,     // Float32Array - detected fundamental pitches
  fundCount,     // number - how many pitches detected
  pitchClasses,  // number[] - unique pitch classes [0-11]
  stable,        // boolean - has detection stabilized?
  chord,         // object | null - detected chord
  maxEnergy,     // number - loudest FFT bin this frame
}
```

### `chord` object

```javascript
{
  root: 'C',        // note name
  rootPc: 0,        // pitch class (0-11)
  name: 'Major',    // full chord name
  abbrev: '',       // suffix (m, maj7, dim, etc)
  full: 'C',        // root + abbrev ("Cmaj7", "F#m", etc)
}
```

### Utilities

```javascript
PitchPlease.midiToNote(60)           // 'C'
PitchPlease.midiToNote(60, true)     // 'C4'
PitchPlease.matchChord([0, 4, 7])    // { full: 'C', ... }
PitchPlease.pitchClassToColor(0)     // 'hsla(60,80%,50%,1)'
PitchPlease.NOTE_NAMES               // ['C','C#','D',...]
```

## Chord Types

**Triads:** Major, Minor, Dim, Aug, Sus4, Sus2, 5
**Sevenths:** Maj7, 7, m7, m(maj7), dim7, ø7, aug7
**Sixths:** 6, m6
**Extensions:** add9, madd9, 9, m9, maj9, 11, 13

## Dev

```bash
bun dev-testing.js
# http://localhost:3000
```

## How it works

1. FFT via Web Audio `AnalyserNode` (16384 bins)
2. Adaptive noise floor estimation
3. Peak detection with parabolic interpolation
4. Harmonic sieve groups peaks into fundamentals
5. Pitch class extraction and stability check
6. Template matching against chord intervals
