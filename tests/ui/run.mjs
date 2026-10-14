// UI test in a real headless Chrome with a fake microphone that loops tests/fixtures/chord-a-major.wav (a held
// A major chord from MAESTRO: E2 A2 C#3 E3 A3 C#4 E4). Serves the repo, opens the demo, clicks Ready, then switches
// fast -> piano -> voice -> fft live and samples what the page shows. Screenshots go to tests/ui-shots/.
//
//   node tests/ui/run.mjs [--chrome /path/to/chrome] [--seconds 6]
//
// Gates per model (fixed before the first run): the chord the page holds most often is 'A'; the notes shown include
// A, C# and E; for trained models >= 80% of shown notes are A, C# or E; frames arrive at the model's rate; the mic is
// requested once in total; the console has no errors.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = join(ROOT, 'tests/ui-shots');
const WAV = join(ROOT, 'tests/fixtures/chord-a-major.wav');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const CHROME = arg('--chrome', process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const SECONDS = Number(arg('--seconds', 6));
const MODELS = ['fast', 'piano', 'voice', 'fft'];
const EXPECT_PCS = new Set(['A', 'C#', 'E']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static server for the repo
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(ROOT)) return res.writeHead(403).end();
  try { res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- Chrome over the DevTools protocol
const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'pp-ui-'))}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`,
  '--autoplay-policy=no-user-gesture-required', '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox', '--window-size=1280,860',
  'about:blank'], { stdio: 'ignore' });
const console_ = [], exceptions = [];
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, userGesture = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(100); } throw new Error(`timed out: ${expr}`); };

const results = {};
let ok = true;
try {
  let tabs;
  for (let i = 0; i < 80 && !tabs; i++) { await sleep(250); try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
  if (!tabs) throw new Error(`Chrome did not start (${CHROME})`);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') console_.push({ level: m.params.type, text: m.params.args.map((a) => a.value ?? a.description).join(' ') });
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded') console_.push({ level: m.params.entry.level, text: `${m.params.entry.text} ${m.params.entry.url ?? ''}`.trim() });
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  // count microphone requests
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__gum = 0; { const md = navigator.mediaDevices, o = md.getUserMedia.bind(md); md.getUserMedia = (c) => (window.__gum++, o(c)); }` });
  await send('Page.navigate', { url: `${origin}/index.html?model=fast` });
  await until(`document.readyState === 'complete' && !!window.pitchplease`);
  await evaluate(`document.getElementById('start').click()`, true);
  await until(`window.pitchplease.running`, 20000);
  results.chrome = version.Browser;

  for (const model of MODELS) {
    if (model !== 'fast') await evaluate(`document.querySelector('[data-model=${model}]').click()`, true);
    await until(`window.pitchplease.stats.model === '${model}'`, 20000);
    await sleep(1500); // let the new engine settle and the chord come round in the 2 s loop
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) {
      samples.push(await evaluate(`({ chord: document.getElementById('chord').dataset.chord, notes: document.getElementById('notes').textContent.trim(), cpu: document.getElementById('cpu').textContent, stats: window.pitchplease.stats })`));
      await sleep(50);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `${model}.png`), Buffer.from(shot.data, 'base64'));

    const chordCount = new Map(), tokens = [];
    for (const s of samples) {
      if (s.chord) chordCount.set(s.chord, (chordCount.get(s.chord) ?? 0) + 1);
      if (s.notes) tokens.push(...s.notes.split(/\s+/));
    }
    const pcOf = (name) => name.replace(/-?\d+$/, '');
    const shownPcs = new Set(tokens.map(pcOf));
    const inChord = tokens.filter((t) => EXPECT_PCS.has(pcOf(t))).length / Math.max(1, tokens.length);
    const modal = [...chordCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const last = samples.at(-1).stats;
    const noteCounts = Object.fromEntries([...tokens.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 10));
    const gates = {
      modalChordIsA: modal === 'A',
      showsACsharpE: [...EXPECT_PCS].every((pc) => shownPcs.has(pc)),
      notesInChord: model === 'fft' ? true : inChord >= 0.8,
      frameRate: model === 'fft' ? last.framesPerSecond > 10 : last.framesPerSecond > 80 && last.framesPerSecond < 92,
      statsModel: last.model === model,
    };
    results[model] = { gates, modalChord: modal, chordsShown: Object.fromEntries(chordCount), shareOfNotesInAMajor: +inChord.toFixed(3), topNotes: noteCounts,
      samples: samples.length, cpuLoad: +last.cpuLoad.toFixed(3), framesPerSecond: +last.framesPerSecond.toFixed(1), kernel: last.kernel, sampleRate: last.sampleRate, cpuLabel: samples.at(-1).cpu };
    ok &&= Object.values(gates).every(Boolean);
  }
  results.micRequests = await evaluate('window.__gum');
  results.errorBanner = await evaluate(`document.getElementById('error').classList.contains('show') ? document.getElementById('error').textContent : null`);
  const errors = console_.filter((c) => c.level === 'error');
  results.consoleErrors = errors;
  results.exceptions = exceptions;
  results.consoleOther = console_.filter((c) => c.level !== 'error' && c.level !== 'debug').slice(0, 10);
  ok &&= results.micRequests === 1 && !results.errorBanner && errors.length === 0 && exceptions.length === 0;
} catch (e) {
  ok = false;
  results.failure = String(e.stack ?? e);
} finally {
  ws?.close();
  chrome.kill();
  server.close();
}
results.PASS = ok;
console.log(JSON.stringify(results, null, 1));
process.exit(ok ? 0 : 1);
