// Fetch a URL's bytes in browsers, workers, Node, Bun and Deno. Node's fetch() cannot read file: URLs, so file: goes
// through node:fs. The fs module is reached without a static import, so bundlers never see a Node built-in.

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
