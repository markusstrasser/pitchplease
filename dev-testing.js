// Local dev server for the demo: bun dev-testing.js -> http://localhost:3000 (the mic needs localhost or https)
const mimes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
};

Bun.serve({
  port: 3000,
  async fetch(req) {
    let path = new URL(req.url).pathname;
    if (path === '/') path = '/index.html';

    const ext = path.slice(path.lastIndexOf('.'));
    const file = Bun.file('.' + path);

    if (await file.exists()) {
      return new Response(file, {
        headers: { 'Content-Type': mimes[ext] || 'application/octet-stream' }
      });
    }
    return new Response('Not found', { status: 404 });
  }
});

console.log('http://localhost:3000');
