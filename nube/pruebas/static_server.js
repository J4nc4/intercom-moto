'use strict';
// Sirve docs/ como lo haría GitHub Pages, con config.js apuntando al simulador.
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2];
const port = Number(process.argv[3] || 8080);
const scriptUrl = process.argv[4];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/config.js' && scriptUrl) {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    return res.end(`window.INTERCOM_CONFIG = { SCRIPT_URL: ${JSON.stringify(scriptUrl)} };`);
  }
  const f = path.join(root, path.normalize(p));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1');
console.log('docs en http://localhost:' + port);
