const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 4090;
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject'
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Remove leading slash
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const filepath = path.join(__dirname, pathname);

  // Prevent directory traversal attacks
  const realpath = path.resolve(filepath);
  if (!realpath.startsWith(path.resolve(__dirname))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filepath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
    } else {
      const ext = path.extname(filepath);
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      // no-store on everything: this server only exists for active local
      // testing (often through a Cloudflare Tunnel), where "I edited a file,
      // reloaded, and it's still running the old code" is a much worse
      // failure mode than losing static-asset caching would ever save.
      // Without this, a normal refresh isn't enough to see a change — the
      // tunnel's own edge cache (Cloudflare caches static extensions like
      // .js by default, even with no origin cache headers at all) can keep
      // serving a stale copy of project-data.js or any other file. no-store
      // tells both the browser AND that edge cache not to keep anything.
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}/ (listening on 0.0.0.0)`);
});
