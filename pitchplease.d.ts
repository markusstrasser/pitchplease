// Type definitions for @markusstrasser/pitchplease 3.0
// Self-contained: no DOM lib needed (browser objects are typed structurally).

/** 'fast' (default), 'piano' and 'voice' are trained detectors; 'fft' is the v2 FFT peak picker. */
export type ModelId = 'fast' | 'piano' | 'voice' | 'fft';

/** Detector kernel: 'auto' picks the fastest one this runtime supports. */
export type KernelId = 'auto' | 'js';

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
  /** Seconds into the audio (since start(), or since the first sample for analyze()). */
  time: number;
  /** Stream time (s) at which this frame became available; emitTime - time is the detector's own latency. */
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
  /** Median ms from a note's onset to its first detected frame on held-out piano (missed notes count as never). */
  readonly latencyMs: number;
  /** Frame-level note F1 on held-out piano (MAESTRO). */
  readonly pianoF1: number;
  /** Frame-level note F1 on held-out guitar (GuitarSet). */
  readonly guitarF1: number;
  /** Frame-level note F1 on held-out solo singing (Dagstuhl ChoirSet). */
  readonly voiceF1: number;
  /** The operating point the model was calibrated at; null for 'fft'. */
  readonly threshold: Readonly<Threshold> | null;
}

export interface CommonOptions {
  /** Which detector to run (default 'fast'). See `models`. */
  model?: ModelId;
  /** Override the trained models' on/off probabilities. Given only `on`, off = 0.6 * on. Ignored by 'fft'. */
  threshold?: Partial<Threshold>;
  /** Folder that holds fast.bin, piano.bin and voice.bin, if you host the weights yourself (a string or a URL). */
  modelBaseUrl?: string | { readonly href: string };
  /** Detector kernel (default 'auto'). */
  kernel?: KernelId;
  /** Frames the pitch-class set must hold before a chord is named (default 1 for trained models, 4 for 'fft'). */
  stabilityFrames?: number;
  /** ms with no notes before the held chord clears (default 200). */
  clearAfterMs?: number;
  /** 'fft' only: FFT size (default 16384). */
  fftSize?: number;
  /** 'fft' only: spectrum bins analysed (default 500). */
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
  /** Receives every error. Without it, start() and setModel() reject instead. */
  onError?: (error: PitchPleaseError) => void;
}

export type AnalyzeOptions = CommonOptions;

export interface Stats {
  /** The model producing frames now. */
  model: ModelId;
  /** The kernel running the trained model ('js'), null for 'fft'. */
  kernel: string | null;
  /** Detector compute time / audio time, measured in the audio thread (0.5 = half the real-time budget). */
  cpuLoad: number;
  framesPerSecond: number;
  /** The AudioContext's sample rate (0 when stopped). */
  sampleRate: number;
}

/** Anything with a MediaStream's track list, e.g. a browser MediaStream. */
export interface MediaStreamLike {
  getTracks(): ArrayLike<{ stop(): void }>;
}

/** A Web Audio AudioBuffer, or anything shaped like one. */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

export interface Detector {
  /** Open the microphone (or use `source`) and start detecting. Call it from a click or key handler. */
  start(source?: MediaStreamLike): Promise<void>;
  /** Stop detecting and release the microphone. start() works again afterwards. */
  stop(): void;
  /** Pause or resume; returns the new paused state. */
  togglePause(): boolean;
  /** Switch models while running, without asking for the microphone again. Before start(), it preloads the weights. */
  setModel(id: ModelId): Promise<void>;
  readonly paused: boolean;
  readonly running: boolean;
  /** The selected model. */
  readonly model: ModelId;
  readonly stats: Stats;
}

export type ErrorCode =
  | 'unknown-model' | 'bad-options' | 'bad-threshold' | 'bad-input' | 'bad-source'
  | 'unknown-kernel' | 'kernel-unsupported' | 'kernel-load-failed'
  | 'no-web-audio' | 'insecure-context' | 'no-microphone-api' | 'worklet-unsupported' | 'worklet-load-failed'
  | 'mic-denied' | 'mic-not-found' | 'mic-busy' | 'mic-failed'
  | 'model-load-failed' | 'processor-error';

export class PitchPleaseError extends Error {
  readonly name: 'PitchPleaseError';
  /** Stable machine-readable reason; `message` says what to do about it. */
  readonly code: ErrorCode;
}

/** A live detector. Nothing is downloaded or opened until start(). Throws a PitchPleaseError on invalid options. */
export function create(options?: Options): Detector;

/** Detect notes in recorded audio, in the browser or Node. Any sample rate (48 kHz and 22.05 kHz need no resampling). */
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
