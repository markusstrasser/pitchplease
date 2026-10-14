// Fetch a URL's bytes in browsers, workers, Node, Bun and Deno. Node's fetch() cannot read file: URLs, so file: goes
// through node:fs. The fs module is reached without a static import, so bundlers never see a Node built-in.
import { PitchPleaseError } from './errors.js';

/** Resolve a file inside an optional asset folder, keeping its query string. */
export function folderUrl(path, value, option = 'assetBaseUrl') {
  let raw;
  try {
    raw = typeof value === 'object' && typeof value?.href === 'string' ? value.href : String(value);
    if ((typeof value !== 'string' && !(typeof value?.href === 'string')) || !raw.trim()) throw new TypeError('expected a string or URL');
    const base = new URL(raw, globalThis.location?.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const url = new URL(path, base);
    url.search = base.search;
    return url;
  } catch (e) {
    throw new PitchPleaseError('bad-options', `${option} '${raw}' is not a URL here` + (globalThis.location ? '.' :
      ': outside a browser it must be absolute, e.g. a file: or https: URL of the folder.'), { cause: e });
  }
}

export async function fetchBytes(url) {
  url = url instanceof URL ? url : new URL(String(url), globalThis.location?.href);
  if (url.protocol === 'file:') {
    const fs = globalThis.process?.getBuiltinModule?.('node:fs/promises') ?? await importNodeFs();
    const buf = await fs.readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.arrayBuffer();
}

function importNodeFs() {
  const name = 'node:fs/promises'; // a variable keeps bundlers from resolving it
  return import(/* webpackIgnore: true */ /* @vite-ignore */ name);
}
