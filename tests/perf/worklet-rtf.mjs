// Offline worklet benchmark (not part of npm test). From the repo root:
//   PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/perf/worklet-rtf.mjs
// Install Playwright in a scratch folder, not as a runtime dependency. Its Chromium, Firefox and WebKit builds
// must be installed (`npx playwright install`). System Chrome can be selected with CHROMIUM_EXECUTABLE_PATH.
// Options: --browsers webkit,chromium,firefox --models fast,piano,voice --runs 3 --seconds 30
//          --kernel auto|wasm-relaxed|wasm-simd|js --compile bytes|module|warm-module --isolated --output /tmp/rtf.json
// `module` compiles on the main thread and tests structured cloning into processorOptions; no silent fallback.
// `warm-module` passes the Module the main-thread arm has just run. Every run also times the same kernel on the page's
// main thread before and after the render (mainRtfBefore/After), and a plain-JS loop on both threads
// (mainProbeMs/workletProbeMs), so a worklet slowdown can be told apart from a slow thread under the same load.
// Fixture: the shipped MAESTRO A-major excerpt, looped to 30 s at 48 kHz. Fetch/decode/main-thread compile are untimed.
// RTF is startRendering() wall time / audio duration, including rendering, scheduling and message overhead
// (and worklet initialization if the browser defers construction until rendering). It is not pure CPU time.
// cpuLoad is the processor's own metric, weighted by audio duration; early/late windows are wholly within
// 0–5 s / 25–30 s. Clock diagnostics use 20,000 consecutive reads, then reads throughout the render.
// Every raw run records uptime before/after. JSON preserves raw values and median/min/max for each metric.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const summarize = (values) => {
  const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  return v.length ? { median: (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2, min: v[0], max: v.at(-1) } : null;
};

// Instrument a copy of the generated processor: the production code and timing boundaries stay intact.
export function diagnosticWorkletSource(source) {
  const registration = "registerProcessor('pitchplease', PitchPleaseProcessor);";
  if (!source.includes(registration)) throw new Error('Worklet registration changed: update benchmark instrumentation');
  return source.replace(registration, `
registerProcessor('pitchplease-perf', class extends PitchPleaseProcessor {
  constructor(options) {
    super(options);
    this.perfSamples = 0;
    this.perfLength = options.processorOptions.perfLength;
    this.perfClock = globalThis.performance?.now ? 'performance.now' : 'Date.now';
    this.perfResolution = Infinity;
    this.perfPositive = 0;
    this.perfReads = 0;
    this.perfPrevious = clock();
    for (let i = 0; i < 20000; i++) this.perfReadClock();
    this.port.postMessage({ type: 'perf-clock', clock: this.perfClock,
      resolutionMs: Number.isFinite(this.perfResolution) ? this.perfResolution : null });
  }
  perfReadClock() {
    const now = clock(), delta = now - this.perfPrevious;
    if (delta > 0) { this.perfResolution = Math.min(this.perfResolution, delta); this.perfPositive++; }
    this.perfPrevious = now;
    this.perfReads++;
  }
  // Plain-JS compute probe (same loop as the page's): separates thread speed from WASM compilation tier.
  perfProbe() {
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = clock();
      let a = 0.5, b = 0.25;
      for (let i = 0; i < 3e7; i++) { a = a * 1.0000001 + b; b = b * 0.9999999 - a * 1e-9; }
      best = Math.min(best, clock() - t0);
      if (a + b === 42) best = -1; // keep the loop observable
    }
    this.port.postMessage({ type: 'perf-probe', ms: best });
  }
  process(inputs, outputs, parameters) {
    if (!this.perfProbed) { this.perfProbed = true; this.perfProbe(); }
    const alive = super.process(inputs, outputs, parameters);
    this.perfReadClock();
    const ch = inputs[0]?.[0];
    if (ch && !this.paused && alive) {
      this.perfSamples += ch.length;
      if (this.samples === 0) this.port.postMessage({ type: 'perf-window', samples: this.perfSamples });
    }
    if (!this.perfDone && this.perfSamples >= this.perfLength) {
      this.perfDone = true;
      this.port.postMessage({ type: 'perf-end', samples: this.perfSamples,
        resolutionMs: Number.isFinite(this.perfResolution) ? this.perfResolution : null,
        positiveDeltas: this.perfPositive, clockReads: this.perfReads });
    }
    return alive;
  }
});`);
}

// Playwright serializes this function into the page. baseUrl also lets the loader path be checked in Node/Bun.
export async function renderWorklet({ model, seconds, kernel, compile, baseUrl = '' }) {
  const [{ loadModel }, { resolveKernel }] = await Promise.all([import(baseUrl + '/engine/models.js'), import(baseUrl + '/engine/kernel-load.js')]);
  if (typeof loadModel !== 'function' || typeof resolveKernel !== 'function') throw new Error('Benchmark loader exports changed');
  const [{ manifest, weights }, selected] = await Promise.all([loadModel(model), resolveKernel(kernel)]);
  // 'module': compiled here, cold when the worklet gets it; 'warm-module': the same Module the main-thread arm runs first.
  const workletModule = compile !== 'bytes' && selected.wasm ? await WebAssembly.compile(selected.wasm) : null;
  const wasm = workletModule ?? selected.wasm;
  const sr = 48000, length = Math.round(seconds * sr);
  const ctx = new OfflineAudioContext(1, length, sr);
  if (!ctx.audioWorklet) throw new Error('OfflineAudioContext.audioWorklet is unavailable');
  const decoded = await ctx.decodeAudioData(await (await fetch('/tests/fixtures/chord-a-major.wav')).arrayBuffer());
  const fixture = ctx.createBuffer(1, length, sr), samples = fixture.getChannelData(0);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  for (let i = 0; i < length; i++) {
    for (const ch of channels) samples[i] += ch[i % decoded.length] / channels.length;
  }
  // Main-thread arm: the same kernel on the same samples in 128-sample pushes, timed before and after the worklet
  // render, so the worklet/main ratio is paired under the same machine load.
  const mainModule = selected.wasm ? (compile === 'warm-module' ? workletModule : await WebAssembly.compile(selected.wasm)) : undefined;
  const mainThreadRtf = () => {
    const det = selected.impl.createDetector(selected.impl.parseWeights(manifest, weights), { inputRate: sr, wasmModule: mainModule });
    const t0 = performance.now();
    for (let i = 0; i + 128 <= length; i += 128) det.push(samples.subarray(i, i + 128));
    return (performance.now() - t0) / (seconds * 1000);
  };
  const mainRtfBefore = mainThreadRtf();
  const mainProbeMs = (() => { // the worklet's perfProbe loop, timed here
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      let a = 0.5, b = 0.25;
      for (let i = 0; i < 3e7; i++) { a = a * 1.0000001 + b; b = b * 0.9999999 - a * 1e-9; }
      best = Math.min(best, performance.now() - t0);
      if (a + b === 42) best = -1;
    }
    return best;
  })();
  let workletProbeMs = null;
  await ctx.audioWorklet.addModule('/perf-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pitchplease-perf', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
    channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { manifest, weights, impl: selected.choice.impl, wasmBytes: wasm, perfLength: length },
  });
  const stats = [];
  let clockInfo, endInfo, statsMessage, resolveEnd, rejectEnd, audioEnd = 0;
  const done = new Promise((r, j) => { resolveEnd = r; rejectEnd = j; });
  // An explicit timeout prevents a stopped processor from producing a plausible benchmark result.
  const timeout = setTimeout(() => rejectEnd(new Error('Missing worklet completion marker')), 90000);
  node.onprocessorerror = () => rejectEnd(new Error('Worklet processor crashed'));
  node.port.onmessage = ({ data: msg }) => {
    if (msg.type === 'error') rejectEnd(new Error(msg.message));
    if (msg.type === 'perf-clock') clockInfo = msg;
    if (msg.type === 'perf-probe') workletProbeMs = msg.ms;
    if (msg.type === 'perf-end') { endInfo = msg; resolveEnd(); }
    if (msg.type === 'stats') statsMessage = msg;
    if (msg.type === 'perf-window') {
      const end = msg.samples / sr;
      if (!statsMessage || end <= audioEnd || !Number.isFinite(statsMessage.cpuLoad)) {
        rejectEnd(new Error('Stats/window instrumentation lost synchronization'));
        return;
      }
      stats.push({ start: audioEnd, end, duration: end - audioEnd, cpuLoad: statsMessage.cpuLoad });
      audioEnd = end;
      statsMessage = null;
    }
  };
  const input = ctx.createBufferSource(); input.buffer = fixture;
  input.connect(node).connect(ctx.destination); input.start();
  let wallMs;
  try {
    const started = performance.now();
    const rendering = ctx.startRendering().then(() => { wallMs = performance.now() - started; });
    await Promise.all([rendering, done]);
  } finally { clearTimeout(timeout); node.port.close(); node.disconnect(); }
  const mean = (windows) => windows.length ? windows.reduce((s, w) => s + w.cpuLoad * w.duration, 0) / windows.reduce((s, w) => s + w.duration, 0) : null;
  if (!stats.length || !clockInfo || !endInfo) throw new Error('Incomplete diagnostics');
  const mainRtfAfter = mainThreadRtf();
  return { kernel: selected.choice.id, crossOriginIsolated, wallMs, rtf: wallMs / (seconds * 1000), mainRtfBefore, mainRtfAfter, mainProbeMs, workletProbeMs,
    cpuLoad: mean(stats), earlyCpuLoad: mean(stats.filter((w) => w.end <= 5)),
    lateCpuLoad: mean(stats.filter((w) => w.start >= 25 && w.end <= 30)),
    clock: clockInfo.clock, clockResolutionMs: endInfo.resolutionMs,
    initialClockResolutionMs: clockInfo.resolutionMs, clockReads: endInfo.clockReads,
    positiveClockDeltas: endInfo.positiveDeltas, statsWindows: stats.length, statsAudioSeconds: audioEnd };
}

async function main() {
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url))); // no trailing slash: the server checks ROOT + sep
const arg = (key, fallback) => {
  const i = process.argv.indexOf(key);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${key} needs a value`);
  return process.argv[i + 1];
};
const browsers = arg('--browsers', 'webkit,chromium,firefox').split(',');
const models = arg('--models', 'fast,piano,voice').split(',');
const runs = Number(arg('--runs', 3)), seconds = Number(arg('--seconds', 30));
const kernel = arg('--kernel', 'auto'), compile = arg('--compile', 'bytes');
const isolated = process.argv.includes('--isolated');
if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(seconds) || seconds < 30 ||
    !['bytes', 'module', 'warm-module'].includes(compile) || models.some((m) => !['fast', 'piano', 'voice'].includes(m)) ||
    browsers.some((b) => !['webkit', 'chromium', 'firefox'].includes(b))) throw new Error('Invalid benchmark options (seconds >= 30)');
const modulePath = process.env.PLAYWRIGHT_MODULE;
const playwright = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright');
const uptime = () => execFileSync('uptime', { encoding: 'utf8' }).trim();

const diagnosticSource = diagnosticWorkletSource(readFileSync(resolve(ROOT, 'engine/worklet.js'), 'utf8'));
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.wav': 'audio/wav' };
const server = createServer((req, res) => {
  if (isolated) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Worklet RTF</title>');
  if (pathname === '/perf-worklet.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(diagnosticSource);
  const file = resolve(ROOT, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(ROOT + sep)) return res.writeHead(403).end();
  let body;
  try { body = readFileSync(file); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const result = { timestamp: new Date().toISOString(), seconds, runs, compile, isolated, kernel,
  fixture: 'tests/fixtures/chord-a-major.wav (looped)', configurations: [], errors: [] };
try {
  for (const name of browsers) {
    let browser;
    try {
      browser = await playwright[name].launch({ headless: true, timeout: 20000,
        ...(name === 'chromium' && process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
      for (const model of models) {
        const config = { browser: name, version: browser.version(), model, measurements: [] };
        result.configurations.push(config);
        for (let run = 1; run <= runs; run++) {
          const page = await browser.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          try {
            await page.goto(origin);
            const before = uptime();
            const measured = await page.evaluate(renderWorklet, { model, seconds, kernel, compile });
            if (errors.length) throw new Error(errors.join('; '));
            const row = { run, ...measured, uptimeBefore: before, uptimeAfter: uptime() };
            config.measurements.push(row);
            console.log(JSON.stringify({ browser: name, version: config.version, model, ...row }));
          } catch (e) {
            result.errors.push({ browser: name, model, run, message: e.stack ?? String(e), uptime: uptime() });
            console.error(`${name}/${model}/${run}: ${e.message}`);
          } finally { await page.close(); }
        }
        config.summary = Object.fromEntries(['rtf', 'mainRtfBefore', 'mainRtfAfter', 'cpuLoad', 'earlyCpuLoad', 'lateCpuLoad', 'clockResolutionMs'].map((k) => [k, summarize(config.measurements.map((r) => r[k]))]));
        config.complete = config.measurements.length === runs;
        console.log(JSON.stringify({ browser: name, model, summary: config.summary, complete: config.complete,
          loads: config.measurements.map((r) => ({ before: r.uptimeBefore, after: r.uptimeAfter })) }));
      }
    } catch (e) {
      result.errors.push({ browser: name, message: e.stack ?? String(e), uptime: uptime() });
      console.error(`${name}: ${e.message}`);
    } finally { if (browser) await browser.close(); }
  }
} finally {
  server.close();
  const output = arg('--output', '/tmp/pitchplease-worklet-rtf.json');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Results: ${output}`);
  if (result.errors.length) process.exitCode = 1;
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
