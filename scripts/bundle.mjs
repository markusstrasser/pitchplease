// A minimal bundler for the AudioWorklet: inlines engine/processor.js and the engine modules it imports into one
// self-contained script (engine/worklet.js). A worklet cannot import relative modules after Vite or webpack copy it
// as an asset, so the shipped worklet has no imports at all.
//
// It accepts only the module shapes the engine uses and fails loudly on anything else:
//   import * as name from './x.js';            import { a, b as c } from './x.js';
//   export function|async function|const|class name ...   (top level, at the start of a line, one name each)
// `export let` is refused (the bundle would copy the value, not keep a live binding), and so is a named import the
// target does not export. `export const a = 1, b = 2` cannot be told apart by line, so verifyExports() compares
// what was found with the module's real exports (scripts/build.mjs and the tests run it).
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const IMPORT_NS = /^import \* as (\w+) from '(\.\/[\w.-]+\.js)';\s*$/;
const IMPORT_NAMED = /^import \{([^}]*)\} from '(\.\/[\w.-]+\.js)';\s*$/;
const EXPORT_DECL = /^export (async function|function|const|class) (\w+)/;

function parse(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const imports = [], exports = [], body = [];
  for (const [i, line] of lines.entries()) {
    let m;
    if ((m = IMPORT_NS.exec(line))) { imports.push({ ns: m[1], from: m[2] }); body.push(''); continue; }
    if ((m = IMPORT_NAMED.exec(line))) {
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const p = /^(\w+)(?: as (\w+))?$/.exec(s);
        if (!p) throw new Error(`${file}:${i + 1}: cannot bundle import specifier '${s}'`);
        return { name: p[1], local: p[2] ?? p[1] };
      });
      imports.push({ names, from: m[2] }); body.push(''); continue;
    }
    if ((m = EXPORT_DECL.exec(line))) { exports.push(m[2]); body.push(line.slice('export '.length)); continue; }
    if (/^export let\b/.test(line)) throw new Error(`${file}:${i + 1}: cannot bundle 'export let' (the bundle would not keep it live); export a function or const`);
    if (/^\s*(import|export)\b/.test(line) && !/^\s*import\(/.test(line)) throw new Error(`${file}:${i + 1}: cannot bundle '${line.trim()}'`);
    body.push(line);
  }
  return { imports, exports, body: body.join('\n') };
}

/** Returns the bundled source of `entry` (a path), the files it inlined, and the exports it found in each. */
export function bundle(entry, banner) {
  const order = [], seen = new Map(); // file -> { v: module var, mod }
  const visit = (file) => {
    if (seen.has(file)) return seen.get(file);
    seen.set(file, null); // cycle guard
    const mod = parse(file);
    for (const imp of mod.imports) {
      const target = visit(join(dirname(file), imp.from));
      if (!target) throw new Error(`${file}: import cycle through ${imp.from}`);
      imp.var = target.v;
      for (const n of imp.names ?? []) {
        if (!target.mod.exports.includes(n.name)) throw new Error(`${file}: imports '${n.name}', which ${imp.from} does not export`);
      }
    }
    const v = `__m${order.length}_` + basename(file).replace(/\W/g, '_'); // the index keeps a-b.js and a_b.js apart
    const entryInfo = { v, mod };
    seen.set(file, entryInfo);
    order.push({ file, v, mod });
    return entryInfo;
  };
  visit(entry);
  const out = [banner];
  for (const { file, v, mod } of order) {
    const head = mod.imports.map((imp) => imp.ns
      ? `const ${imp.ns} = ${imp.var};`
      : `const { ${imp.names.map((n) => (n.name === n.local ? n.name : `${n.name}: ${n.local}`)).join(', ')} } = ${imp.var};`).join('\n');
    const rel = relative(dirname(entry), file);
    if (file === entry) out.push(`// ---- ${rel}\n{\n${head}\n${mod.body.trimEnd()}\n}\n`);
    else out.push(`// ---- ${rel}\nconst ${v} = (() => {\n${head}\n${mod.body.trimEnd()}\nreturn { ${mod.exports.join(', ')} };\n})();\n`);
  }
  return { code: out.join('\n'), files: order.map((o) => o.file), exports: new Map(order.map((o) => [o.file, o.mod.exports])) };
}

/** Problems ([] if none) where a bundled module's real exports differ from what bundle() found in it. */
export async function verifyExports({ files, exports }, entry = files.at(-1)) {
  const problems = [];
  for (const file of files) {
    if (file === entry) continue; // the entry's exports are not used (and it may need worklet globals to load)
    const real = Object.keys(await import(pathToFileURL(file).href)).sort();
    const found = [...exports.get(file)].sort();
    if (real.join() !== found.join()) problems.push(`${file}: exports ${real.join(', ')}, the bundler found ${found.join(', ')} (one export per declaration)`);
  }
  return problems;
}
