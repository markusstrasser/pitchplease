// Type definitions for @markusstrasser/pitchplease 3.0
// Self-contained: no DOM lib needed (browser objects are typed structurally).

/**
 * 'fast' (default), 'piano' and 'voice' are trained detectors; 'fft' is v2's FFT peak picker. Minor releases may add
 * models, so handle unknown ids (for example with a default branch).
 */
export type ModelId = 'fast' | 'piano' | 'voice' | 'fft';

/** Detector kernel: 'auto' picks the fastest one this runtime supports. Lists engine/kernels.js CHOICES (tested). */
export type KernelId = 'auto' | 'wasm-relaxed' | 'wasm-simd' | 'js';

export interface Chord {
  /** Root note name, e.g. 'C#'. */
  root: string;
  /** Root pitch class (0 = C ... 11 = B). */
  rootPc: number;
  /** Chord quality, e.g. 'Major', 'm7'. */
  name: string;
  /** Suffix, e.g. '', 'm', 'maj7'. */
  abbrev: string;
  /** root + abbrev, e.g. 'Cmaj7', 'F#m'. */
  full: string;
}

export interface Note {
  /** MIDI note number: A0 = 21 ... C8 = 108. */
  midi: number;
  /** Name with octave, e.g. 'C#4'. */
  name: string;
  /** 0 = C ... 11 = B. */
  pitchClass: number;
  /** The model's probability for this key (0-1). For 'fft', the fundamental's harmonic score (0.5-1]. */
  prob: number;
}

export interface Frame {
  /**
   * analyze(): seconds into the input. Live: unpaused session time since start(), continuous across setModel().
   */
  time: number;
  /** Same clock as time (s), when this frame became available; emitTime - time is the detector's own latency. */
  emitTime: number;
  /** The 88 key probabilities, A0 (index 0) to C8 (index 87). null for 'fft'. */
  probs: Float32Array | null;
  /** Keys that are on in this frame, lowest first. */
  notes: Note[];
  /** Unique pitch classes of `notes`, ascending. */
  pitchClasses: number[];
  /** The pitch-class set has been the same for stabilityFrames frames. */
  stable: boolean;
  /** The held chord: kept until another chord matches, null after clearAfterMs with no notes. */
  chord: Chord | null;
}

/** v2's per-frame payload. For trained models, `spectrum` holds the 88 key probabilities and `binMidi` their MIDI numbers. */
export interface UpdateData {
  spectrum: Float32Array;
  binMidi: Float32Array;
  fundMidis: Float32Array;
  fundCount: number;
  pitchClasses: number[];
  stable: boolean;
  chord: Chord | null;
  maxEnergy: number;
  threshold: number;
  peakBins: Float32Array;
  peakEnergies: Float32Array;
  peakCount: number;
  notes: Note[];
  probs: Float32Array | null;
  model: ModelId;
}

export interface Threshold {
  /** A key turns on when its probability rises above `on`... */
  on: number;
  /** ...and stays on until it falls below `off` (0 < off <= on < 1). */
  off: number;
}

export interface ModelInfo {
  readonly id: ModelId;
  readonly label: string;
  /** True for 'fast', the model create() uses when none is given. */
  readonly default: boolean;
  readonly useCase: string;
  /** Download size in KB (1024 bytes); 0 for 'fft'. */
  readonly sizeKB: number;
  /** Compute per second of audio relative to 'fast'; null for 'fft' (a different, much lighter engine). */
  readonly relativeCost: number | null;
  /**
   * Piano onset latency: the median ms from a note's onset to its first detected frame on held-out piano (MAESTRO),
   * missed notes counted as never detected. Guitar and singing latencies are in the README.
   */
  readonly latencyMs: number;
  /** Frame-level note F1 on held-out piano (MAESTRO). */
  readonly pianoF1: number;
  /** Frame-level note F1 on held-out guitar (GuitarSet). */
  readonly guitarF1: number;
  /** Frame-level note F1 on held-out solo singing (Dagstuhl ChoirSet). */
  readonly voiceF1: number;
  /** The operating point the model was calibrated at; null for 'fft'. */
  readonly threshold: Readonly<Threshold> | null;
  /** Identifies the weights; changes whenever a model is retrained. null for 'fft'. */
  readonly revision: string | null;
}

export interface CommonOptions {
  /** Which detector to run (default 'fast'). See `models`. */
  model?: ModelId;
  /**
   * Override the trained models' on/off probabilities. The values are absolute and apply to whichever trained model
   * runs. Given only `on`, off = 0.6 * on; given only `off`, the running model's own `on` applies. create() checks it
   * against the selected model; setModel() against the target, failing (old model kept) if it does not fit.
   * Ignored by 'fft'.
   */
  threshold?: Partial<Threshold>;
  /**
   * Folder that holds fast.bin, piano.bin and voice.bin, if you host the weights yourself (a string or a URL; a
   * query such as ?v=3 is kept). Outside a browser it must be absolute. Takes precedence over assetBaseUrl for models.
   */
  modelBaseUrl?: string | { readonly href: string };
  /**
   * Folder containing engine/ and models/ copied from this package release. Relocates the worklet, WASM and models.
   * A string or URL; relative to the page in browsers, absolute required in Node. A query string is kept.
   */
  assetBaseUrl?: string | { readonly href: string };
  /** Detector kernel (default 'auto'; under 'auto', a WASM kernel that fails falls back to JavaScript). */
  kernel?: KernelId;
  /** Frames the pitch-class set must hold before a chord is named (default 1 for trained models, 4 for 'fft'). */
  stabilityFrames?: number;
  /** ms with no notes before the held chord clears (default 200). */
  clearAfterMs?: number;
  /** 'fft' only: FFT size, a power of two from 32 to 32768 (default 16384). */
  fftSize?: number;
  /** 'fft' only: spectrum bins analysed, 1 to fftSize / 2 (default 500, or fftSize / 2 if smaller). */
  binCount?: number;
}

export interface Options extends CommonOptions {
  /** Called once per detector frame (~86/s for trained models, once per animation frame for 'fft') with the keys that are on. */
  onNotes?: (notes: Note[], frame: Frame) => void;
  /** Called when a new chord is held. */
  onChord?: (chord: Chord) => void;
  /** Called once when the held chord clears after clearAfterMs of silence (or when setModel() swaps models). */
  onChordEnd?: () => void;
  /** v2's per-frame callback. */
  onUpdate?: (data: UpdateData) => void;
  /**
   * Receives every error, always a PitchPleaseError (an unexpected one has code 'internal-error' and the original as
   * `cause`). Without it, start() and setModel() reject instead, and errors after start() go to console.error.
   */
  onError?: (error: PitchPleaseError) => void;
}

export type AnalyzeOptions = CommonOptions;

export interface Stats {
  /** The model producing frames now. */
  model: ModelId;
  /** The kernel running the trained model (what 'auto' picked), null for 'fft'. */
  kernel: Exclude<KernelId, 'auto'> | null;
  /** Detector compute time / audio time, measured in the audio thread (0.5 = half the real-time budget). */
  cpuLoad: number;
  framesPerSecond: number;
  /** The AudioContext's sample rate (0 when stopped). */
  sampleRate: number;
}

/** A browser MediaStream, also one from another frame. It needs an audio track. */
export interface MediaStreamLike {
  getTracks(): ArrayLike<{ stop(): void }>;
  getAudioTracks(): ArrayLike<unknown>;
}

/** A Web Audio AudioBuffer, or anything shaped like one. */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

export interface Detector {
  /**
   * Open the microphone (or use `source`) and start detecting. Call it from a click or key handler; a context that
   * still starts suspended resumes on the next click or key press. An ended audio track stops detection and reports
   * mic-ended; start() can be called again. Calls made while starting or running share that
   * outcome; a `source` passed while starting or running is ignored (stop() first). Resolves true once the engine runs, false if start failed (the error went to onError) or stop()
   * cancelled it. Without onError, a failure rejects instead.
   */
  start(source?: MediaStreamLike): Promise<boolean>;
  /** Stop detecting, release an owned microphone (a supplied stream is left running) and clear the pause. Cancels a pending start quietly. */
  stop(): void;
  /** Pause or resume; returns the new paused state. Before start() (or after stop()) it does nothing and returns false. */
  togglePause(): boolean;
  /**
   * Switch models while running, without asking for the microphone again: the new model takes over once it runs; if
   * it cannot, the old one keeps running and the error is reported. The old engine continues through the new one's
   * first frame; timestamps stay on the unpaused session clock. Before start(), it selects and preloads.
   * Resolves the model running afterwards: `id` on success, the old model if the switch failed (with onError), null
   * if nothing runs (not started, or stopped meanwhile). Without onError, a failure rejects instead.
   */
  setModel(id: ModelId): Promise<ModelId | null>;
  readonly paused: boolean;
  /**
   * A session is started: the engine is installed. Outside a click or key handler the audio context can still be
   * suspended, and frames then wait until it resumes (on the next click or key press). Interruptions attempt resume
   * and fall back to the next gesture. An ended microphone or externally closed context stops the session.
   */
  readonly running: boolean;
  /** The selected model. */
  readonly model: ModelId;
  readonly stats: Stats;
}

/** Minor releases may add codes; treat an unknown one like 'internal-error'. */
export type ErrorCode =
  | 'unknown-model' | 'bad-options' | 'bad-threshold' | 'bad-input' | 'bad-source'
  | 'unknown-kernel' | 'kernel-unsupported' | 'kernel-load-failed'
  | 'no-web-audio' | 'insecure-context' | 'no-microphone-api' | 'worklet-unsupported' | 'worklet-load-failed'
  | 'mic-denied' | 'mic-not-found' | 'mic-busy' | 'mic-failed' | 'mic-ended'
  | 'model-load-failed' | 'processor-error' | 'internal-error';

export class PitchPleaseError extends Error {
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown });
  readonly name: 'PitchPleaseError';
  /** Stable machine-readable reason; `message` says what to do about it. */
  readonly code: ErrorCode;
}

/** A live detector. Nothing is downloaded or opened until start(). Throws a PitchPleaseError on invalid options. */
export function create(options?: Options): Detector;

/**
 * Detect notes in recorded audio, in the browser or Node: a Float32Array (or any array of numbers) with its sample
 * rate, or an AudioBuffer. Any sample rate (48 kHz and 22.05 kHz need no resampling). Rejects with a PitchPleaseError.
 */
export function analyze(samples: Float32Array | ArrayLike<number>, sampleRate: number, options?: AnalyzeOptions): Promise<Frame[]>;
export function analyze(buffer: AudioBufferLike, options?: AnalyzeOptions): Promise<Frame[]>;

/** One entry per model, for building pickers. */
export const models: readonly ModelInfo[];
export const version: string;

export function matchChord(pitchClasses: number[]): Chord | null;

export interface ChordHold {
  /** pcs: pitch classes this frame; stable: the set has held for stabilityFrames; now: ms timestamp. */
  update(pcs: number[], stable: boolean, now: number): 'chord' | 'clear' | null;
  readonly chord: Chord | null;
}

export function createChordHold(clearAfterMs?: number): ChordHold;
export function midiToNote(midi: number, withOctave?: boolean): string;
export function pitchClassToColor(pc: number, s?: number, l?: number, a?: number): string;
export const NOTE_NAMES: string[];

declare const PitchPlease: {
  create: typeof create;
  analyze: typeof analyze;
  models: typeof models;
  version: typeof version;
  matchChord: typeof matchChord;
  createChordHold: typeof createChordHold;
  midiToNote: typeof midiToNote;
  pitchClassToColor: typeof pitchClassToColor;
  NOTE_NAMES: typeof NOTE_NAMES;
  PitchPleaseError: typeof PitchPleaseError;
};
export default PitchPlease;
