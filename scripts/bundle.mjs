// A minimal bundler for the AudioWorklet: inlines engine/processor.js and the engine modules it imports into one
// self-contained script (engine/worklet.js). A worklet cannot import relative modules after Vite or webpack copy it
// as an asset, so the shipped worklet has no imports at all.
//
// It accepts only the module shapes the engine uses and fails loudly on anything else:
//   import * as name from './x.js';            import { a, b as c } from './x.js';
//   export function|async function|const|let|class name ...   (top level, at the start of a line)
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const IMPORT_NS = /^import \* as (\w+) from '(\.\/[\w.-]+\.js)';\s*$/;
const IMPORT_NAMED = /^import \{([^}]*)\} from '(\.\/[\w.-]+\.js)';\s*$/;
const EXPORT_DECL = /^export (async function|function|const|let|class) (\w+)/;

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
    if (/^\s*(import|export)\b/.test(line) && !/^\s*import\(/.test(line)) throw new Error(`${file}:${i + 1}: cannot bundle '${line.trim()}'`);
    body.push(line);
  }
  return { imports, exports, body: body.join('\n') };
}

/** Returns the bundled source of `entry` (a path) and the list of files it inlined. */
export function bundle(entry, banner) {
  const order = [], seen = new Map(); // file -> module var
  const visit = (file) => {
    if (seen.has(file)) return seen.get(file);
    seen.set(file, null); // cycle guard
    const mod = parse(file);
    for (const imp of mod.imports) {
      imp.var = visit(join(dirname(file), imp.from));
      if (!imp.var) throw new Error(`${file}: import cycle through ${imp.from}`);
    }
    const v = '__' + relative(dirname(entry), file).replace(/\W/g, '_');
    seen.set(file, v);
    order.push({ file, v, mod });
    return v;
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
  return { code: out.join('\n'), files: order.map((o) => o.file) };
}
