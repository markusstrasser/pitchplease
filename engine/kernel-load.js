// Main-thread side of the kernel seam: pick a kernel (engine/kernels.js) and fetch what it needs. The worklet gets
// the .wasm bytes and compiles them itself; analyze() on the main thread gets a compiled module.
import { PitchPleaseError } from './errors.js';
import { CHOICES, IMPLS, pickKernel } from './kernels.js';
import { fetchBytes } from './load.js';

const wasmBytes = new Map(); // kernel id -> Promise<ArrayBuffer>
const wasmModules = new Map(); // kernel id -> Promise<WebAssembly.Module>

function kernelBytes(choice) {
  if (!wasmBytes.has(choice.id)) {
    const url = choice.wasm();
    wasmBytes.set(choice.id, fetchBytes(url).catch((e) => {
      wasmBytes.delete(choice.id);
      throw new PitchPleaseError('kernel-load-failed', `Could not load the '${choice.id}' kernel from ${url.href}: ${e.message}.`, { cause: e });
    }));
  }
  return wasmBytes.get(choice.id);
}

/**
 * Resolves { choice, impl, wasm }: wasm is the .wasm bytes (want 'bytes', for the worklet) or a compiled module
 * (want 'module', for the main thread), undefined for the JS kernel. With 'auto', a kernel that fails to load falls
 * back to the next supported choice and says so on the console.
 */
export async function resolveKernel(preference = 'auto', want = 'bytes', choices = CHOICES) {
  let choice = pickKernel(preference, choices);
  for (;;) {
    try {
      if (!choice.wasm) return { choice, impl: IMPLS[choice.impl], wasm: undefined };
      const bytes = await kernelBytes(choice);
      if (want === 'bytes') return { choice, impl: IMPLS[choice.impl], wasm: bytes };
      if (!wasmModules.has(choice.id)) wasmModules.set(choice.id, WebAssembly.compile(bytes));
      return { choice, impl: IMPLS[choice.impl], wasm: await wasmModules.get(choice.id) };
    } catch (e) {
      if (preference !== 'auto') throw e;
      const next = pickKernel('auto', choices.slice(choices.indexOf(choice) + 1));
      if (!next) throw e;
      console.warn(`[pitchplease] ${e.message} Falling back to the '${next.id}' kernel.`);
      choice = next;
    }
  }
}
