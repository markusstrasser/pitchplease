// The DSP kernel seam. A kernel is a module with the API of engine/incport.js:
//
//   parseWeights(manifest, buffer)                       -> weights
//   createDetector(weights, { inputRate, wasmModule })  -> { push(Float32Array) -> [{ t, emit, probs: Float32Array(88) }] }
//
// The main thread picks one kernel (pickKernel here; fetching in engine/kernel-load.js), and both the AudioWorklet
// (engine/processor.js, bundled into engine/worklet.js) and analyze() run that choice. The worklet gets the raw .wasm
// bytes in processorOptions and compiles them synchronously (new WebAssembly.Module), which avoids posting a
// compiled WebAssembly.Module to a worklet (unverified on Safari and Firefox).
//
// To add the WASM-SIMD kernel (pitchtest/web/incport-wasm.js and its .wasm builds, once committed there):
//   1. npm run vendor -- incport-wasm.js incport.wasm incport-relaxed.wasm   (copies them, records the commit)
//   2. uncomment the wasmKernel import and its IMPLS entry below
//   3. uncomment the two CHOICES entries (one per .wasm build, best first, each with the feature probe it needs)
//   4. add their ids to KernelId in pitchplease.d.ts (a test compares the two)
//   5. npm run build (regenerates engine/worklet.js), npm test (parity runs every supported choice), npm run test:ui
// The kernel module must stay bundler-safe: no import('node:…') and only literal `new URL('./x', import.meta.url)`.
import { PitchPleaseError } from './errors.js';
import * as jsKernel from './incport.js';
// import * as wasmKernel from './incport-wasm.js';

export const IMPLS = { js: jsKernel /* , wasm: wasmKernel */ };

// Tiny modules for WebAssembly.validate (synchronous, microseconds).
// simd128: (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt)
export const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
// relaxed SIMD: (func (result v128) v128.const 0 v128.const 0 v128.const 0 f32x4.relaxed_madd), the instruction the
// relaxed kernel build uses (Safari has no relaxed SIMD)
const V128_ZERO = [253, 12, ...new Array(16).fill(0)];
export const RELAXED_SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 61, 1, 59, 0, ...V128_ZERO, ...V128_ZERO, ...V128_ZERO, 253, 133, 2, 11]);

// Best first. impl: a key of IMPLS; probe: bytes WebAssembly.validate must accept; wasm: the binary's URL (a static
// `new URL('./…', import.meta.url)` so bundlers emit the file).
export const CHOICES = [
  // { id: 'wasm-relaxed', impl: 'wasm', probe: RELAXED_SIMD_PROBE, wasm: () => new URL('./incport-relaxed.wasm', import.meta.url) },
  // { id: 'wasm-simd', impl: 'wasm', probe: SIMD_PROBE, wasm: () => new URL('./incport.wasm', import.meta.url) },
  { id: 'js', impl: 'js' },
];

export function kernelSupported(choice) {
  if (!choice.probe) return true;
  try { return typeof WebAssembly === 'object' && WebAssembly.validate(choice.probe); } catch { return false; }
}

/** 'auto' -> the first supported choice; otherwise the named choice. Throws a PitchPleaseError naming the options. */
export function pickKernel(preference = 'auto', choices = CHOICES) {
  if (preference === 'auto') return choices.find(kernelSupported);
  const choice = choices.find((c) => c.id === preference);
  if (!choice) throw new PitchPleaseError('unknown-kernel', `Unknown kernel '${preference}'. Use 'auto' or one of: ${choices.map((c) => c.id).join(', ')}.`);
  if (!kernelSupported(choice)) throw new PitchPleaseError('kernel-unsupported', `Kernel '${preference}' needs a WebAssembly feature this runtime lacks. Use kernel: 'auto' to fall back.`);
  return choice;
}
