// Cut the test fixtures from pitchtest's oracle recordings (48 kHz, 16-bit; web/dump_oracle.py wrote them from the
// held-out test items). Dev-only: node scripts/make-fixtures.mjs [path/to/pitchtest/web/oracle]
// Each slice is a whole number of 128-sample render quanta.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readWav, writeWav } from '../tests/helpers/wav.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORACLE = process.argv[2] ?? join(ROOT, '../pitchtest/web/oracle');
// name: [source item, start s, seconds, what is in it (MAESTRO / GuitarSet / ChoirSet ground truth)]
export const FIXTURES = {
  'piano-maestro': ['maestro_test', 1.0, 4.0, 'Liszt (MAESTRO test): Dm, A, A7, Dm, Am chords'],
  'guitar-guitarset': ['guitarset_test', 0.0, 4.0, 'GuitarSet test, player 04, bossa nova comping'],
  'voice-dcs': ['dcs_solo', 0.0, 4.0, 'Dagstuhl ChoirSet solo singer'],
  'chord-a-major': ['maestro_test', 14.2, 2.0, 'MAESTRO test, a held A major chord: E2 A2 C#3 E3 A3 C#4 E4 (UI test microphone)'],
};

for (const [name, [item, start, seconds, what]] of Object.entries(FIXTURES)) {
  const { samples, sampleRate } = readWav(join(ORACLE, `${item}.wav`));
  if (sampleRate !== 48000) throw new Error(`${item}.wav is ${sampleRate} Hz, expected 48000`);
  const n = Math.round(seconds * sampleRate / 128) * 128, i0 = Math.round(start * sampleRate);
  writeWav(join(ROOT, 'tests/fixtures', `${name}.wav`), samples.subarray(i0, i0 + n), sampleRate);
  console.log(`tests/fixtures/${name}.wav  ${n} samples  ${what}`);
}
