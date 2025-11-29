const mimes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

Bun.serve({
  port: 3000,
  async fetch(req) {
    let path = new URL(req.url).pathname;
    if (path === '/') path = '/app.html';

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
