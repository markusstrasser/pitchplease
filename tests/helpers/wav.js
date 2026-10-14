// 16-bit PCM WAV read/write for the test fixtures (mono or the first channel).
import { readFileSync, writeFileSync } from 'node:fs';

export function readWav(path) {
  const b = readFileSync(path);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = dv.getUint32(off + 4, true), body = off + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${path}: only 16-bit PCM is supported`);
      const n = Math.floor(size / 2 / fmt.channels), samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = dv.getInt16(body + i * 2 * fmt.channels, true) / 32768;
      return { samples, sampleRate: fmt.sampleRate };
    }
    off = body + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

export function writeWav(path, samples, sampleRate) {
  const n = samples.length, b = Buffer.alloc(44 + 2 * n);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + 2 * n, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), 44 + 2 * i);
  writeFileSync(path, b);
}
