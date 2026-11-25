'use strict';
// Local dev server: serves public/ and routes /api/* to the same handler Vercel runs.
const http = require('http'), fs = require('fs'), path = require('path');
const handler = require('../api/index.js');
const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function start(port) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) return handler(req, res);
    let f = path.join(PUB, req.url.split('?')[0]);
    if (!f.startsWith(PUB)) { res.statusCode = 403; return res.end(); }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) f = path.join(PUB, 'index.html');
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.end(fs.readFileSync(f));
  });
  return new Promise(r => srv.listen(port, () => r(srv)));
}
module.exports = { start };
if (require.main === module) start(process.env.PORT || 8790).then(() => console.log('http://localhost:' + (process.env.PORT || 8790)));
