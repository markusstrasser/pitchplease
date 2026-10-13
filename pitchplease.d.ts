declare namespace PitchPlease {
  interface Chord {
    root: string;
    rootPc: number;
    name: string;
    abbrev: string;
    full: string;
  }

  interface UpdateData {
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
  }

  interface Options {
    onUpdate?: (data: UpdateData) => void;
    onChord?: (chord: Chord) => void;
    /** Called once when the held chord clears after clearAfterMs of silence. */
    onChordEnd?: () => void;
    onError?: (error: Error) => void;
    fftSize?: number;
    binCount?: number;
    stabilityFrames?: number;
    /** ms with no pitch class heard before the held chord clears (default 200). */
    clearAfterMs?: number;
  }

  interface Detector {
    start(): Promise<void>;
    stop(): void;
    togglePause(): boolean;
    readonly paused: boolean;
  }

  function create(options?: Options): Detector;
  function matchChord(pitchClasses: number[]): Chord | null;

  interface ChordHold {
    /** pcs: pitch classes this frame; stable: the set has held for stabilityFrames; now: ms timestamp. */
    update(pcs: number[], stable: boolean, now: number): 'chord' | 'clear' | null;
    readonly chord: Chord | null;
  }

  function createChordHold(clearAfterMs?: number): ChordHold;
  function midiToNote(midi: number, withOctave?: boolean): string;
  function pitchClassToColor(pc: number, s?: number, l?: number, a?: number): string;
  const NOTE_NAMES: string[];
}

export = PitchPlease;
export as namespace PitchPlease;
