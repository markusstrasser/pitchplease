// Main-thread side of the kernel seam: pick a kernel (engine/kernels.js) and fetch what it needs. The worklet gets
// the .wasm bytes and compiles them itself; analyze() on the main thread gets a compiled module.
import { PitchPleaseError } from './errors.js';
import { CHOICES, IMPLS, WASM_SHA256, pickKernel } from './kernels.js';
import { fetchBytes, folderUrl } from './load.js';

const wasmBytes = new Map(); // resolved URL -> Promise<ArrayBuffer>
const wasmModules = new Map(); // resolved URL -> Promise<WebAssembly.Module>

function kernelBytes(choice, url) {
  const key = url.href;
  if (!wasmBytes.has(key)) {
    wasmBytes.set(key, fetchBytes(url).then(async bytes => {
      const expected = WASM_SHA256[choice.id];
      if (expected && globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        if (actual !== expected) throw new Error(`SHA-256 mismatch (expected ${expected}, got ${actual}). Copy engine/ and models/ from one release`);
      }
      return bytes;
    }).catch((e) => {
      wasmBytes.delete(key);
      throw new PitchPleaseError('kernel-load-failed', `Could not load the '${choice.id}' kernel from ${url.href}: ${e.message}.`, { cause: e });
    }));
  }
  return wasmBytes.get(key);
}

/**
 * Resolves { choice, impl, wasm }: wasm is the .wasm bytes (want 'bytes', for the worklet) or a compiled module
 * (want 'module', for the main thread), undefined for the JS kernel. With 'auto', a kernel that fails to load falls
 * back to the next supported choice and says so on the console.
 */
export async function resolveKernel(preference = 'auto', want = 'bytes', choices = CHOICES, assetBaseUrl) {
  let choice = pickKernel(preference, choices);
  for (;;) {
    try {
      if (!choice.wasm) return { choice, impl: IMPLS[choice.impl], wasm: undefined };
      const url = assetBaseUrl == null ? choice.wasm() : folderUrl(
        choice.id === 'wasm-relaxed' ? 'engine/incport-relaxed.wasm' : 'engine/incport.wasm', assetBaseUrl);
      const key = url.href;
      const bytes = await kernelBytes(choice, url);
      if (want === 'bytes') return { choice, impl: IMPLS[choice.impl], wasm: bytes };
      if (!wasmModules.has(key)) {
        const id = choice.id;
        wasmModules.set(key, WebAssembly.compile(bytes).catch((e) => {
          wasmModules.delete(key);
          throw new PitchPleaseError('kernel-load-failed', `The '${id}' kernel did not compile: ${e.message}.`, { cause: e });
        }));
      }
      return { choice, impl: IMPLS[choice.impl], wasm: await wasmModules.get(key) };
    } catch (e) {
      if (preference !== 'auto') throw e;
      const next = pickKernel('auto', choices.slice(choices.indexOf(choice) + 1));
      if (!next) throw e;
      console.warn(`[pitchplease] ${e.message} Falling back to the '${next.id}' kernel.`);
      choice = next;
    }
  }
}
