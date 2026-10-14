# PitchPlease

Polyphonic pitch and chord detection in the browser. Pick the detector that fits your app: three trained models that
run in an AudioWorklet, or the tiny FFT peak picker from v2. No dependencies, no build step.

**[Try the live demo →](https://markusstrasser.github.io/pitchplease/)**

## Quick start

```bash
npm install @markusstrasser/pitchplease
```

```js
import { create } from '@markusstrasser/pitchplease';

const detector = create({ onNotes: (notes) => console.log(notes.map((n) => n.name).join(' ')) }); // 'E2 A2 C#3'
button.onclick = () => detector.start(); // asks for the microphone
```

Without a bundler, import it from a CDN (or from a copy of the package folder) in a module script:

```html
<script type="module">
  import { create } from 'https://cdn.jsdelivr.net/npm/@markusstrasser/pitchplease@3.1.0/pitchplease.js';
  const detector = create({ onChord: (chord) => (document.title = chord.full) });
  document.querySelector('button').onclick = () => detector.start();
</script>
```

Pin the exact version in CDN URLs. The worklet, the `.wasm` kernels and the model files are all fetched relative to
the URL `pitchplease.js` was imported from, so a range like `@3` could mix files of two versions across caches.

The page must be served over `https://` or from `http://localhost`, and `start()` must run inside a click or key
handler: browsers require both for the microphone.

## Pick a model

| model | best for | download | CPU | piano F1 / latency | guitar F1 / latency | singing F1 / latency |
|---|---|---|---|---|---|---|
| `fast` (default) | the default: chords, singing alone; lightest trained model | 495 KB | 1× | 0.679 / 50 ms | 0.784 / 40 ms | **0.911 / 37 ms** |
| `piano` | piano (and guitar) accuracy | 545 KB | 2.1× | **0.729 / 40 ms** | 0.818 / 33 ms | 0.872 / 44 ms |
| `voice` | piano and guitar near `piano`; sung notes about as well as `fast` | 545 KB | 2.1× | 0.726 / 41 ms | **0.821 / 34 ms** | 0.886 / 45 ms |
| `fft` | no download, lightest CPU (v2's engine) | none | tiny | 0.375 / 260 ms | 0.347 / 155 ms | 0.546 / 145 ms |

```js
const detector = create({ model: 'piano', onNotes });
const now = await detector.setModel('voice'); // switch live, without asking for the microphone again; 'voice' unless it failed
```

How to read the table:

- **Scores** are measured on held-out test recordings the models never trained on: 25 MAESTRO piano excerpts,
  20 GuitarSet guitar excerpts and 12 Dagstuhl ChoirSet solo singers. F1 is frame-level note F1 at each model's
  operating point. Latency is the median time from a note's onset to its first detected frame, with missed notes
  counted as never detected. The FFT picker misses 41% of piano onsets; over the notes it does detect, its median is
  150 ms.
- **CPU** is compute per second of audio relative to `fast`: `piano` and `voice` do 2.1× the multiply-adds. The
  detector runs as WebAssembly with SIMD where the browser has it, otherwise as plain JavaScript (`stats.kernel` says
  which). Measured audio-thread load is in the table below. Read `detector.stats.cpuLoad` and fall back to `fast` when
  it stays above 0.8.
- **`voice`** accepts sung notes about as well as `fast` on the vocadito set (89.1% vs 89.7% of notes, median 71 vs
  72 ms), while scoring close to `piano` on piano and guitar. On a newer singer set (M4Singer) it picks a neighbouring
  wrong note less often (46% vs 53% of targets) but accepts slightly fewer notes, slightly later (95.3% vs 96.7%;
  131 vs 125 ms), so parity on new singers is not established. For unaccompanied singing, `fast` scores highest.
- **Operating point**: each trained model turns a key on when its probability rises above `on` and keeps it on until it
  falls below `off` (`fast` 0.7/0.42, `piano` 0.6/0.36, `voice` 0.65/0.39). Override with `threshold: { on, off }`.

Audio-thread time as a share of real time, measured in headless browsers on an Apple M3 Pro that was busy with other
jobs (so a quiet machine does better):

| browser | kernel | `fast` | `piano` | `voice` |
|---|---|---|---|---|
| Chrome 155 | WebAssembly SIMD | 12% | 20% | 20% |
| Firefox 157 | WebAssembly SIMD | 21% | 23% | 23% |
| WebKit 27.2 (Safari's engine) | WebAssembly SIMD | 12% | 57% | 52% |
| Chrome 155 | JavaScript | 29% | 74% | 71% |
| Firefox 157 | JavaScript | 53% | 102% | 101% |

`cpuLoad` reports the real cost: rendering 30 s through the worklet offline takes as long as `cpuLoad` says, within
about 5%, in Chrome and WebKit. WebKit is the outlier. Its main thread runs the WebAssembly detector as fast as
Chrome's (`piano` at 0.16–0.18 of real time), but its audio-worklet thread runs the same code 1.2–5× slower, depending
on machine load, while plain JavaScript on that thread runs only about 1.2× slower. Compiling the module on the main
thread and passing it in did not reliably help. These are Playwright WebKit 27.2 measurements on a loaded M3 Pro; real
Safari is untested. On Safari, watch `stats.cpuLoad` and switch to `fast` if it stays above 0.8.

The JavaScript kernel is the fallback for browsers without WebAssembly SIMD. In WebKit it runs `piano` at 6.6× real
time (`fast`: 0.36×), so on Safari before 16.4 use `fast`.

The same facts are exported for building a picker:

```js
import { models } from '@markusstrasser/pitchplease';
// [{ id: 'fast', label: 'Fast', default: true, useCase: '…', sizeKB: 495, relativeCost: 1, latencyMs: 50,
//    pianoF1: 0.679, guitarF1: 0.784, voiceF1: 0.911, threshold: { on: 0.7, off: 0.42 } }, …]
```

## API

### `create(options)` → detector

Nothing is downloaded or opened until `start()`. Invalid options throw a `PitchPleaseError` right away.

```js
const detector = create({
  model: 'fast',             // 'fast' | 'piano' | 'voice' | 'fft'
  onNotes(notes, frame) {},  // every detector frame (~86/s; 'fft': every animation frame): the keys that are on
  onChord(chord) {},         // a new chord is held
  onChordEnd() {},           // the held chord cleared after clearAfterMs of silence
  onUpdate(data) {},         // v2's per-frame payload (see below)
  onError(err) {},           // every error; without it, start() and setModel() reject instead
  threshold: { on, off },    // trained models: absolute on/off probabilities for whichever model runs (only `on`
                             // given: off = 0.6 * on); setModel() fails if it does not fit the target model
  clearAfterMs: 200,         // silence before the held chord clears
  stabilityFrames: 1,        // frames the pitch-class set must hold before a chord is named (fft default: 4)
  modelBaseUrl: undefined,   // a folder holding fast.bin, piano.bin, voice.bin if you host the weights yourself
  assetBaseUrl: undefined,   // a folder holding copies of engine/ and models/ from this package release
  kernel: 'auto',            // detector kernel; 'auto' picks the fastest this browser supports
  fftSize: 16384,            // 'fft' only: a power of two from 32 to 32768
});
```

| detector | |
|---|---|
| `await start(stream?)` | Opens the microphone (raw: no echo cancellation, noise suppression or gain control) or uses the `MediaStream` you pass (a stream passed while already starting or running is ignored: `stop()` first). Downloads the model while the permission prompt shows. Resolves `true` once detecting, `false` if it failed (with `onError`) or `stop()` cancelled it; a second call while starting or running shares that outcome. |
| `stop()` | Stops, releases the microphone (a stream you passed is left running) and clears the pause. A `start()` still opening is cancelled quietly. `start()` works again. |
| `togglePause()` | Pauses or resumes; returns the new paused state. Without a started session it does nothing and returns `false`. |
| `await setModel(id)` | Swaps models while running: the new model must report ready in the audio thread (within 2 s, else the switch fails); the old one continues until the new one's first frame, then stops. The mic stays open. If the new model fails, the old one keeps running and the error is reported. Resolves the model running afterwards (`id`, the old model after a failure, or `null` when nothing runs). Before `start()`, it selects the model and preloads its weights. |
| `model`, `running`, `paused` | Current state. `running` means the session started and its engine is installed; if the audio context is still suspended (`start()` ran outside a click or key handler), frames begin when it resumes on the next click or key press. |
| `stats` | `{ model, kernel, cpuLoad, framesPerSecond, sampleRate }`. Identifies the engine producing frames, including while a replacement warms up. `cpuLoad` is detector time / audio time, measured in the audio thread (`fft`: on the main thread). |

If a microphone audio track ends (unplugged, revoked access, or a supplied stream's track), the detector stops and
reports `mic-ended`. Reconnect it or allow access, then call `start()` again. A supplied stream stays under your
control; the detector only stops tracks it opened. If another caller closes the AudioContext, detection stops with
`processor-error`. A suspended or interrupted context attempts to resume, then waits for the next click or key press
if necessary; `running` stays true and no error is reported.

**Notes** (`onNotes`) are `{ midi, name, pitchClass, prob }`, lowest first: `{ midi: 61, name: 'C#4', pitchClass: 1,
prob: 0.93 }`. `prob` is the model's probability for that key; for `fft` it is the harmonic score (0.5–1].

**Frames** (`onNotes`' second argument, and what `analyze()` returns):

```js
{
  time,          // analyze(): seconds into the input; live: unpaused session time since start(), across setModel()
  emitTime,      // when the frame became available; emitTime - time = the detector's own latency
  probs,         // Float32Array(88): every key's probability, A0 (index 0) to C8 (index 87); null for 'fft'
  notes,         // the keys that are on
  pitchClasses,  // their unique pitch classes, ascending
  stable,        // the pitch-class set has held for stabilityFrames
  chord,         // the held chord or null
}
```

Live timestamps keep increasing when models change, while preserving each detector's latency. Switching trained
models keeps the frame gap within two detector hops during continuous audio. Switching to or from `fft` can have a
larger gap because its latency and animation-frame cadence differ. A new `start()` after `stop()` begins a new clock.

**Chords** are `{ root: 'C', rootPc: 0, name: 'Maj7', abbrev: 'maj7', full: 'Cmaj7' }`, matched exactly against 22
templates: triads (major, minor, dim, aug, sus4, sus2), sevenths (maj7, 7, m7, m(maj7), dim7, ø7, aug7), sixths (6,
m6) and extensions (add9, madd9, 9, m9, maj9, 11, 13). A chord stays held until another chord matches, and clears
after `clearAfterMs` with no notes. Power chords (E5) and sevenths without a fifth are deliberately not named: on 120
GuitarSet recordings, naming power chords roughly doubled the wrong names shown per minute (`fast`: 28 to 62), because
a decaying chord or a single note's harmonics often leave just a root and fifth; fifthless sevenths added 13–18%.

**`onUpdate`** keeps v2's payload: `spectrum, binMidi, fundMidis, fundCount, pitchClasses, stable, chord, maxEnergy,
threshold, peakBins, peakEnergies, peakCount`, plus `notes`, `probs` and `model`. For trained models, `spectrum` holds
the 88 key probabilities and `binMidi` their MIDI numbers (21–108), so v2 spectrum drawing code still works.

### `analyze(samples, sampleRate, options?)` → `Promise<Frame[]>`

Detects notes in recorded audio, in the browser or in Node. It accepts a `Float32Array` with its sample rate, or an
`AudioBuffer` (`analyze(buffer, options)`; channels are mixed down). 48 kHz and 22.05 kHz go straight in; any other
rate is resampled first. Options are the same as `create()`'s (model, threshold, …).

```js
import { analyze } from '@markusstrasser/pitchplease';

const audio = await new AudioContext().decodeAudioData(await (await fetch('take.wav')).arrayBuffer());
const frames = await analyze(audio, { model: 'piano' });
const chords = frames.filter((f, i) => f.chord && f.chord !== frames[i - 1]?.chord).map((f) => [f.time, f.chord.full]);
```

It runs on the calling thread, about 3× faster than real time for `fast` on an Apple M3 Pro, and yields to the event
loop as it goes; put long files in a Worker.

### Errors

Errors are `PitchPleaseError`s with a stable `code` and a message that says what to do:

| code | when |
|---|---|
| `mic-denied`, `mic-not-found`, `mic-busy`, `mic-failed` | the microphone could not be opened |
| `mic-ended` | a microphone audio track ended; the detector stops (reconnect or allow access, then call `start()` again) |
| `insecure-context` | the page is not on https:// or localhost |
| `no-microphone-api` | the browser has no `getUserMedia` (pass a `MediaStream` to `start(stream)`) |
| `worklet-unsupported` | no AudioWorklet in this browser (use `model: 'fft'`) |
| `model-load-failed` | the weights could not be fetched (check that `models/` is served, or set `modelBaseUrl`) |
| `worklet-load-failed` | `engine/worklet.js` could not be loaded |
| `processor-error` | the detector could not be built, stopped in the audio thread, or its AudioContext was closed; the detector stops (call `start()` again) |
| `no-web-audio` | `start()` outside a browser (use `analyze()`) |
| `unknown-model`, `bad-threshold`, `bad-options`, `bad-input`, `bad-source`, `unknown-kernel`, `kernel-unsupported`, `kernel-load-failed` | invalid arguments or kernel problems |
| `internal-error` | anything unexpected; the original error is `err.cause` |

### Utilities

```js
import { matchChord, createChordHold, midiToNote, pitchClassToColor, NOTE_NAMES, version } from '@markusstrasser/pitchplease';
midiToNote(61)            // 'C#'
midiToNote(61, true)      // 'C#4'
matchChord([0, 4, 7])     // { full: 'C', … }
pitchClassToColor(0)      // 'hsla(60,80%,50%,1)'
```

## Bundlers, CDNs and self-hosting

The package is an ES module. The AudioWorklet (`engine/worklet.js`) and the weights (`models/*.bin`) are separate
files that the code locates with `new URL('./…', import.meta.url)`, which bundlers understand. Checked with no
configuration: Vite 8 (dev server and production build), webpack 5, a plain `<script type="module">`, and a
cross-origin CDN import. Each model file downloads only when that model is used.

- **webpack** warns that the three `.bin` files exceed its 244 KiB asset hint. They are fetched on demand, so the
  warning can be ignored (or silenced with `performance: { hints: false }`).
- **Self-hosting all assets**: copy `engine/` and `models/` from the same package release into a folder and pass
  `assetBaseUrl: 'https://cdn.example.com/pp/'` to `create()` or `analyze()`. The worklet loads from
  `pp/engine/worklet.js`, the kernels from `pp/engine/incport.wasm` and `pp/engine/incport-relaxed.wasm`, and weights
  from `pp/models/<id>.bin`. Relative bases resolve against the page URL in browsers; Node needs an absolute URL
  (including `file:` for local copies). A query string on the base is kept on every asset URL.
- **Self-hosting the weights**: copy `models/` anywhere and pass `modelBaseUrl: 'https://cdn.example.com/weights/'`.
  It takes precedence over `assetBaseUrl` for models only. Without `assetBaseUrl`, `engine/` stays next to
  `pitchplease.js`.
- **Keep a release together**: a worklet from another package version fails with `worklet-load-failed`; weights from
  another model revision fail with `model-load-failed`. WASM bytes are checked against the shipped SHA-256 when
  `crypto.subtle` is available. A mismatch fails with `kernel-load-failed` for an explicit kernel; `auto` warns and
  tries the next supported kernel. `models` exposes each trained model's `revision`, which identifies its weights
  and changes when it is retrained (`null` for `fft`). `engine/vendor.json` records the exporting commit, source
  hashes, revision and operating point for each model.
- **Cross-origin**: the worklet and the weights need CORS headers when served from another origin (public npm CDNs
  send them).
- **Node**: `analyze()` works in Node ≥ 20.19 and Bun; `require('@markusstrasser/pitchplease')` works too.
- **TypeScript**: `pitchplease.d.ts` ships with the package and needs no DOM types.

## Changes in 3.1

- `assetBaseUrl` serves the worklet, the WebAssembly kernels and the models from one folder of your own. Files from
  different releases now fail with a clear error instead of misbehaving: the worklet reports its version, kernel
  bytes are checked against their SHA-256, and each model file carries a weights `revision` (also in `models`).
- An unplugged or revoked microphone stops the detector and reports `mic-ended`. An interrupted or suspended audio
  context resumes by itself, or on the next click or key press. A context closed by someone else reports
  `processor-error`.
- Live `frame.time` keeps counting across `setModel()`; in 3.0 it restarted near 0 with each model. The old model
  keeps running until the new one's first frame.
- Trained weights and detected notes are unchanged from 3.0.

## Migrating from v2

- **The default detector changed.** v3 runs the trained `fast` model. `model: 'fft'` runs v2's FFT detector as it
  stands in its final source (git 365f53f, a test checks every frame against that file). That is **not** the detector
  published as npm 2.0.0, which differs:
  - `matchChord` in 2.0.0 accepts 2 pitch classes and the best partial match (score above 0.5, with a power-chord
    `5` template), so `[0, 7]` is C5, `[0, 4, 10]` is C7 and `[0, 3, 4, 7]` is C. v3 needs 3 or more pitch classes and
    an exact interval match, and has no `5` template: all three give `null`.
  - The harmonic sieve in 2.0.0 accepts a fundamental without harmonics and above a score of 0.3, with a 0.5-semitone
    tolerance. v3 needs at least 2 harmonics, a score above 0.5 and a 0.7-semitone tolerance, so it reports fewer
    notes.
  - 2.0.0 holds the last chord forever. v3 clears it after `clearAfterMs` (200 ms) of silence and calls `onChordEnd`;
    `clearAfterMs: Infinity` keeps the old hold-forever behaviour.

  A test runs the npm 2.0.0 file (`tests/fixtures/pitchplease-npm-2.0.0.js`) and asserts these chord differences.
- **It is an ES module.** Replace `<script src="pitchplease.js">` and the global `PitchPlease` with
  `<script type="module">` and `import { create } from './pitchplease.js'` (or `import PitchPlease from …` to keep the
  `PitchPlease.create` style). Copy the whole package folder (`pitchplease.js`, `engine/`, `models/`), not just
  `pitchplease.js`. CommonJS `require()` still works in Node ≥ 20.19.
- **New**: `onNotes(notes, frame)`, `onChordEnd`, `setModel()`, `models`, `analyze()`, `stats`, `running`, `model`,
  `threshold`, `modelBaseUrl`, `createChordHold`, error codes.
- **Errors**: `start()` still calls `onError` when you pass one, and then resolves `false`. Without `onError`, `start()`
  and `setModel()` now reject instead of logging.
- **Chords** come from the same `matchChord` and `createChordHold` as v2's final source. With trained models,
  `stabilityFrames` defaults to 1, because the models' on/off hysteresis already steadies the notes; `fft` keeps 4.
- **Behaviour fixes**: the AudioContext is created at 48 kHz inside the click, before the permission prompt, so it is
  not left suspended; a pause and resume within one animation frame no longer starts a second detection loop.

## How it works

The trained models are a streaming port of a basic-pitch-style network (constant-Q transform, small convolutional head,
88 key probabilities every 11.6 ms) with heads fine-tuned on real recordings. It runs in an AudioWorklet on the audio
thread: 48 kHz input is resampled to 22.05 kHz inside the detector, each frame looks ahead 23 ms, and decoding (on/off
hysteresis per key, then chord matching) happens on the main thread. The three models share the architecture; `piano`
and `voice` add a side convolution that doubles the compute.

The `fft` model is v2: a Web Audio AnalyserNode spectrum (16384 bins), an adaptive noise floor, peak picking with
parabolic interpolation, a harmonic sieve that groups peaks into fundamentals, then the same chord matching.

## Browser support

The trained models need AudioWorklet (Chrome and Edge 66+, Firefox 76+, Safari 14.1+), and run fastest with
WebAssembly SIMD (Chrome 91+, Firefox 89+, Safari 16.4+); `fft` runs wherever the Web Audio API does. Both need a secure
page (https or localhost) and a user gesture for the microphone. Tested headless on macOS in Chrome 155, Firefox 157 and
WebKit 27.2 (Playwright's build of Safari's engine), not yet on phones; `fast` leaves the most CPU headroom there.

## Development

```bash
bun dev-testing.js     # demo at http://localhost:3000
npm test               # checks engine/worklet.js is current, then bun test --parallel (one worker per test file)
npm run test:ui        # headless Chrome with a fake microphone: all four models, then retry after a denied mic and
                       # after a failed model download; screenshots in tests/ui-shots/
npm run build          # regenerate engine/worklet.js after editing engine/processor.js or the kernel
npm run vendor -- incport-wasm.js incport.wasm   # re-vendor kernel files from a committed ../pitchtest/web
PLAYWRIGHT_MODULE=…/playwright/index.mjs node tests/perf/worklet-rtf.mjs --browsers webkit,chromium
                       # worklet render time vs the main thread, per browser and model (Playwright installed separately)
```

`engine/worklet.js` is generated: the worklet must be a single file because bundlers copy it as an asset without its
imports. The detector kernels (JavaScript, and WebAssembly SIMD in a plain and a relaxed-SIMD build) are chosen in one
place, `engine/kernels.js`. They are vendored from pitchtest; `engine/vendor.json` records each file's source commit
and hash, and when `../pitchtest` is checked out the tests compare each copy with that file at its recorded commit
(edits in pitchtest's working tree or newer commits only print a note).

## License

MIT
