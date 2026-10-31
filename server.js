'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 10000);
const MAX = 250 * 1024 * 1024;
const TYPES = new Set([
  'audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-wav',
  'audio/ogg','audio/flac','audio/webm','video/mp4','video/webm',
  'video/quicktime','application/ogg','application/octet-stream'
]);

function isPrivateIP(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }
  if (family === 6) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) {
      const mapped = s.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateIP(mapped);
    }
    return s === '::' || s === '::1' || s.startsWith('fc') ||
      s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('::ffff:');
  }
  return true;
}

async function validate(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL provided.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only public HTTP/HTTPS direct media links are allowed.');
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost'))
    throw new Error('Private addresses are strictly forbidden.');

  let addresses;
  try {
    addresses = net.isIP(url.hostname)
      ? [url.hostname]
      : (await dns.lookup(url.hostname, { all: true, verbatim: true })).map(x => x.address);
  } catch { throw new Error('Could not resolve DNS address for this host.'); }

  if (!addresses.length || addresses.some(isPrivateIP))
    throw new Error('This host resolves to a non-public or forbidden address.');

  return { url, ip: addresses[0] };
}

function requestPinned(url, ip, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': '*/*', ...headers },
      lookup: (hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        const family = net.isIP(ip);
        if (!family) return callback(new Error('Invalid IP address format.'));
        if (options && options.all) callback(null, [{ address: ip, family }]);
        else callback(null, ip, family);
      },
      timeout: 20000
    }, res => resolve({ res, req }));
    req.on('timeout', () => req.destroy(new Error('Source server timed out.')));
    req.on('error', reject);
    req.end();
  });
}

async function probe(raw, depth = 0) {
  if (depth > 4) throw new Error('Too many redirects encountered.');
  const { url, ip } = await validate(raw);
  
  // Use GET with Range to fetch just headers and minimal bytes without downloading full file
  const { res } = await requestPinned(url, ip, 'GET', { Range: 'bytes=0-0' });

  if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
    const next = new URL(res.headers.location, url).href;
    res.resume(); // consume response to free socket
    return probe(next, depth + 1);
  }

  const type = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
  const size = Number(res.headers['content-range']?.split('/').pop() || res.headers['content-length'] || 0);
  const status = res.statusCode;
  res.destroy(); // Safely drop connection after headers

  if (status < 200 || status >= 400) {
    if (status === 429) throw new Error('Source server returned HTTP 429 (Too Many Requests). Try again later.');
    throw new Error(`Source server returned HTTP ${status}.`);
  }
  if (!TYPES.has(type)) throw new Error(`Unsupported media type: ${type}`);
  if (size > MAX) throw new Error(`File exceeds maximum allowed size of 250 MB.`);

  let filename = decodeURIComponent(url.pathname.split('/').pop() || 'media-download')
    .replace(/[\r\n"\\/]/g, '_').slice(0, 120);
  
  if (!path.extname(filename)) {
    const ext = {
      'audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/aac':'.aac',
      'audio/wav':'.wav','audio/x-wav':'.wav','audio/ogg':'.ogg',
      'audio/flac':'.flac','video/mp4':'.mp4','video/webm':'.webm',
      'video/quicktime':'.mov'
    }[type] || '.bin';
    filename += ext;
  }
  return { url: url.href, filename, extension: path.extname(filename).slice(1).toUpperCase(), contentType: type, size: size || null };
}

const sendJSON = (res, status, data) => {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  let parsed;
  try { parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendJSON(res, 400, { error:'Invalid request URL context.' }); }

  if (req.method === 'GET' && parsed.pathname === '/api/health')
    return sendJSON(res, 200, { status:'ok', app:'iBroadcast', version:'2.0.1' });

  if (req.method === 'GET' && parsed.pathname === '/') {
    const file = path.join(__dirname, 'index.html');
    if (!fs.existsSync(file)) return sendJSON(res, 500, { error:'index.html missing from server root.' });
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }

  if (req.method === 'POST' && parsed.pathname === '/api/analyze') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16000) req.destroy(new Error('Payload too large'));
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        if (typeof data.url !== 'string') throw new Error('Please provide a valid media URL.');
        sendJSON(res, 200, await probe(data.url));
      } catch (error) {
        sendJSON(res, 400, { error: error.message || 'Media analysis failed.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/download') {
    const raw = parsed.searchParams.get('url');
    if (!raw) return sendJSON(res, 400, { error:'Missing target URL.' });
    
    try {
      // Analyze once to get the verified info and final URL.
      const info = await probe(raw);
      let current = info.url;

      for (let i = 0; i < 5; i++) {
        const { url, ip } = await validate(current);
        const { res: upstream } = await requestPinned(url, ip, 'GET');
        
        if ([301,302,303,307,308].includes(upstream.statusCode) && upstream.headers.location) {
          current = new URL(upstream.headers.location, url).href;
          upstream.resume();
          continue;
        }
        
        if (upstream.statusCode < 200 || upstream.statusCode >= 400) {
          const status = upstream.statusCode;
          upstream.resume();
          if (status === 429) throw new Error('Source server returned HTTP 429.');
          throw new Error(`Download stream failed with HTTP ${status}`);
        }

        const type = String(upstream.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
        const length = Number(upstream.headers['content-length'] || 0);
        
        if (!TYPES.has(type)) { upstream.resume(); throw new Error('File type became unsupported during download phase.'); }
        if (length > MAX) { upstream.resume(); throw new Error('File exceeded 250 MB size limit.'); }
        
        const headers = {
          'Content-Type': type,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`,
          'X-Content-Type-Options':'nosniff',
          'Cache-Control':'no-store'
        };
        if (length) headers['Content-Length'] = length;
        
        res.writeHead(200, headers);
        
        // Ensure client disconnects propagate back to upstream
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        upstream.on('error', () => { if (!res.writableEnded) res.destroy(); });
        
        upstream.pipe(res);
        return;
      }
      throw new Error('Exceeded redirect limit during download.');
    } catch (error) {
      if (!res.headersSent) sendJSON(res, 400, { error: error.message || 'Media download failed.' });
      else res.destroy();
    }
    return;
  }

  sendJSON(res, 404, { error:'Endpoint not found.' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`iBroadcast backend is listening on port ${PORT}`));
              
