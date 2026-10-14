// Vendor detector kernel files from pitchtest/web into engine/, and check the copies have not drifted.
//
//   node scripts/vendor.mjs incport.js [incport-wasm.js incport.wasm …]   copy committed files, record their commit
//   node scripts/vendor.mjs --check                                       compare engine/ with ../pitchtest/web
//
// Only files committed in pitchtest are vendored (an uncommitted or untracked file is refused). Text files get a
// one-line header naming the source commit; engine/vendor.json records source path, commit and the sha256 of the
// source bytes for every file. The check (also run by tests/engine.test.js) verifies each copy against vendor.json
// always, and byte-compares it with ../pitchtest/web when that checkout exists.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(ROOT, 'engine/vendor.json');
export const PITCHTEST = join(ROOT, '../pitchtest');
const HEADER = /^\/\/ Vendored from pitchtest (\S+) @ (\w+)\. [^\n]*\n/;
const isText = (name) => /\.(js|mjs|json)$/.test(name);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const git = (...args) => execFileSync('git', ['-C', PITCHTEST, ...args], { encoding: 'utf8' }).trim();

/** The vendored bytes without the header line (text files), and the commit the header names. */
export function vendoredBody(name) {
  const bytes = readFileSync(join(ROOT, 'engine', name));
  if (!isText(name)) return { body: bytes, headerCommit: null };
  const m = HEADER.exec(bytes.toString('utf8'));
  if (!m) throw new Error(`engine/${name}: missing the "// Vendored from pitchtest …" header`);
  return { body: bytes.subarray(Buffer.byteLength(m[0])), headerCommit: m[2] };
}

/** Problems with the vendored copies: [] when everything matches. `upstream`: whether pitchtest/web was compared. */
export function checkVendored({ upstream = existsSync(join(PITCHTEST, 'web')) } = {}) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const problems = [];
  for (const [name, entry] of Object.entries(manifest)) {
    const { body, headerCommit } = vendoredBody(name);
    if (sha256(body) !== entry.sha256) problems.push(`engine/${name} was edited after vendoring (sha256 differs from engine/vendor.json)`);
    if (headerCommit !== null && headerCommit !== entry.commit) problems.push(`engine/${name}: header says ${headerCommit}, vendor.json says ${entry.commit}`);
    if (upstream) {
      const src = join(PITCHTEST, entry.from);
      if (!existsSync(src)) problems.push(`${entry.from} is gone from pitchtest`);
      else if (Buffer.compare(readFileSync(src), body) !== 0) problems.push(`engine/${name} differs from pitchtest ${entry.from} (vendored @ ${entry.commit}); if upstream moved on, re-vendor: node scripts/vendor.mjs ${name}`);
    }
  }
  return { problems, upstream };
}

function vendor(names) {
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  for (const name of names) {
    const from = `web/${name}`;
    if (git('status', '--porcelain', '--', from)) throw new Error(`pitchtest ${from} is untracked or has uncommitted changes: commit it there first`);
    const commit = git('log', '-1', '--format=%h', '--', from);
    if (!commit) throw new Error(`pitchtest ${from} has no commits`);
    const src = readFileSync(join(PITCHTEST, from));
    const header = `// Vendored from pitchtest ${from} @ ${commit}. Do not edit here: change it upstream, then node scripts/vendor.mjs ${name}\n`;
    writeFileSync(join(ROOT, 'engine', name), isText(name) ? Buffer.concat([Buffer.from(header), src]) : src);
    manifest[name] = { from, commit, sha256: sha256(src) };
    console.log(`engine/${name}  <- pitchtest ${from} @ ${commit}  (${src.length} bytes)`);
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    const { problems, upstream } = checkVendored();
    for (const p of problems) console.error(`✗ ${p}`);
    if (!upstream) console.log('! ../pitchtest not checked out: compared engine/ with vendor.json only');
    if (problems.length) process.exit(1);
    console.log('✓ vendored files match' + (upstream ? ' pitchtest/web' : ' vendor.json'));
  } else {
    if (!args.length) { console.error('usage: node scripts/vendor.mjs <file in pitchtest/web> … | --check'); process.exit(2); }
    vendor(args);
    console.log('next: npm run build && npm test');
  }
}
