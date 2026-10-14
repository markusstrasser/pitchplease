// Vendor detector kernel files from pitchtest/web into engine/, and check the copies have not drifted.
//
//   node scripts/vendor.mjs incport.js [incport-wasm.js incport.wasm …]   copy committed files, record their commit
//   node scripts/vendor.mjs --check                                       verify engine/ against the recorded commits
//
// Only files committed in pitchtest are vendored (an uncommitted or untracked file is refused). Text files get a
// one-line header naming the full source commit; engine/vendor.json records source path, full commit and the sha256
// of the source bytes. The check (also run by tests/engine.test.js) always verifies each copy against vendor.json.
// When ../pitchtest is checked out it also compares each copy with `git show <recorded commit>:<path>` there, which
// research edits in pitchtest's working tree cannot disturb. Upstream changes since the recorded commit (committed or
// not) are reported as notes, not problems: re-vendor when you want them.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './build.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PITCHTEST = join(ROOT, '../pitchtest');
const HEADER = /^\/\/ Vendored from pitchtest (\S+) @ (\w+)\. [^\n]*\n/;
const isText = (name) => /\.(js|mjs)$/.test(name); // gets a // header line (a JSON file could not take one)
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const gitIn = (repo, args, encoding = 'utf8') => {
  const out = execFileSync('git', ['-C', repo, ...args], { encoding, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
  return encoding ? out.trim() : out;
};

/** The vendored bytes without the header line (text files), and the commit the header names. */
export function vendoredBody(name, root = ROOT) {
  const bytes = readFileSync(join(root, 'engine', name));
  if (!isText(name)) return { body: bytes, headerCommit: null };
  const m = HEADER.exec(bytes.toString('utf8'));
  if (!m) throw new Error(`engine/${name}: missing the "// Vendored from pitchtest …" header`);
  return { body: bytes.subarray(Buffer.byteLength(m[0])), headerCommit: m[2] };
}

/**
 * { problems, notes, upstream }: problems ([] when the copies are intact) fail the check; notes say where pitchtest
 * has moved on. `upstream`: whether a pitchtest git checkout was there to compare with.
 */
export function checkVendored({ root = ROOT, pitchtest = PITCHTEST, upstream = existsSync(join(pitchtest, '.git')) } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'engine/vendor.json'), 'utf8'));
  const problems = [], notes = [];
  for (const [name, entry] of Object.entries(manifest)) {
    const { body, headerCommit } = vendoredBody(name, root);
    if (!/^[0-9a-f]{40}$/.test(entry.commit)) problems.push(`engine/vendor.json: ${name} records '${entry.commit}', not a full commit hash`);
    if (sha256(body) !== entry.sha256) problems.push(`engine/${name} was edited after vendoring (sha256 differs from engine/vendor.json)`);
    if (headerCommit !== null && headerCommit !== entry.commit) problems.push(`engine/${name}: header says ${headerCommit}, vendor.json says ${entry.commit}`);
    if (!upstream) continue;
    let recorded;
    try { recorded = gitIn(pitchtest, ['show', `${entry.commit}:${entry.from}`], null); } catch {
      problems.push(`pitchtest has no ${entry.from} at ${entry.commit} (fetch it, or re-vendor)`);
      continue;
    }
    if (Buffer.compare(recorded, body) !== 0) problems.push(`engine/${name} differs from pitchtest ${entry.from} @ ${entry.commit}`);
    const last = gitIn(pitchtest, ['log', '-1', '--format=%H', '--', entry.from]);
    if (last && last !== entry.commit) notes.push(`pitchtest ${entry.from} changed in ${last.slice(0, 7)} since ${entry.commit.slice(0, 7)}: re-vendor if you want it (node scripts/vendor.mjs ${name})`);
    if (gitIn(pitchtest, ['status', '--porcelain', '--', entry.from])) notes.push(`pitchtest ${entry.from} has uncommitted edits (not vendored)`);
  }
  return { problems, notes, upstream };
}

function vendor(names) {
  const manifestPath = join(ROOT, 'engine/vendor.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const name of names) {
    const from = `web/${name}`;
    if (gitIn(PITCHTEST, ['status', '--porcelain', '--', from])) throw new Error(`pitchtest ${from} is untracked or has uncommitted changes: commit it there first`);
    const commit = gitIn(PITCHTEST, ['log', '-1', '--format=%H', '--', from]);
    if (!commit) throw new Error(`pitchtest ${from} has no commits`);
    const src = readFileSync(join(PITCHTEST, from));
    const header = `// Vendored from pitchtest ${from} @ ${commit}. Do not edit here: change it upstream, then node scripts/vendor.mjs ${name}\n`;
    writeFileSync(join(ROOT, 'engine', name), isText(name) ? Buffer.concat([Buffer.from(header), src]) : src);
    manifest[name] = { from, commit, sha256: sha256(src) };
    console.log(`engine/${name}  <- pitchtest ${from} @ ${commit.slice(0, 7)}  (${src.length} bytes)`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    const { problems, notes, upstream } = checkVendored();
    for (const p of problems) console.error(`✗ ${p}`);
    for (const n of notes) console.log(`note: ${n}`);
    if (!upstream) console.log('! ../pitchtest not checked out: compared engine/ with vendor.json only');
    if (problems.length) process.exit(1);
    console.log('✓ vendored files match' + (upstream ? ' their recorded pitchtest commits' : ' vendor.json'));
  } else {
    if (!args.length) { console.error('usage: node scripts/vendor.mjs <file in pitchtest/web> … | --check'); process.exit(2); }
    vendor(args);
    console.log('next: npm run build && npm test');
  }
}
