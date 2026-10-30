const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const httpModule = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (parsed.pathname === '/api/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      status: 'ok',
      app: 'iBroadcast'
    }));
  }

  if (parsed.pathname === '/') {
    const file = path.join(__dirname, 'index.html');

    if (!fs.existsSync(file)) {
      res.writeHead(500);
      return res.end('index.html not found');
    }

    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return fs.createReadStream(file).pipe(res);
  }

  if (parsed.pathname === '/api/analyze') {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end('Method not allowed');
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const url = new URL(data.url);

        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('Unsupported URL');
        }

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
          success: true,
          url: url.href,
          message: 'URL received. Direct media support only.'
        }));
      } catch (error) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({success: false, error: 'Invalid URL'}));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`iBroadcast running on port ${PORT}`);
});
