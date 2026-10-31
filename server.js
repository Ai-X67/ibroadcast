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
  try { url = new URL(raw); } catch { throw new Error('লিংকটি সঠিক URL নয়।'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('শুধু public HTTP/HTTPS direct media link গ্রহণ করা হয়।');
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost'))
    throw new Error('Private address অনুমোদিত নয়।');

  let addresses;
  try {
    addresses = net.isIP(url.hostname)
      ? [url.hostname]
      : (await dns.lookup(url.hostname, { all: true, verbatim: true })).map(x => x.address);
  } catch { throw new Error('এই host-এর DNS address পাওয়া যায়নি।'); }

  if (!addresses.length || addresses.some(isPrivateIP))
    throw new Error('এই host নিরাপদ public address নয়।');

  return { url, ip: addresses[0] };
}

function requestPinned(url, ip, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      headers: { 'User-Agent': 'iBroadcast/2.0', 'Accept': '*/*', ...headers },
      lookup: (hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        const family = net.isIP(ip);
        if (!family) return callback(new Error('Invalid IP address'));
        if (options && options.all) callback(null, [{ address: ip, family }]);
        else callback(null, ip, family);
      },
      timeout: 20000
    }, res => resolve({ res, req }));
    req.on('timeout', () => req.destroy(new Error('Source server timeout.')));
    req.on('error', reject);
    req.end();
  });
}

async function probe(raw, depth = 0) {
  if (depth > 4) throw new Error('অতিরিক্ত redirect পাওয়া গেছে।');
  const { url, ip } = await validate(raw);
  const { res } = await requestPinned(url, ip, 'GET', { Range: 'bytes=0-0' });

  if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
    const next = new URL(res.headers.location, url).href;
    res.resume();
    return probe(next, depth + 1);
  }

  const type = String(res.headers['content-type'] || 'application/octet-stream')
    .split(';')[0].toLowerCase();
  const size = Number(res.headers['content-range']?.split('/').pop() ||
    res.headers['content-length'] || 0);
  const status = res.statusCode;
  res.destroy();

  if (status < 200 || status >= 300) {
    if (status === 429) throw new Error('Source server সাময়িকভাবে অনেক request পেয়েছে (HTTP 429)। কিছুক্ষণ পরে চেষ্টা করুন।');
    throw new Error(`Source HTTP ${status} দিয়েছে।`);
  }
  if (!TYPES.has(type)) throw new Error(`এই ফাইলের ধরন সমর্থিত নয়: ${type}`);
  if (size > MAX) throw new Error('সর্বোচ্চ ফাইল সাইজ ২৫০ MB।');

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
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  let parsed;
  try { parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendJSON(res, 400, { error:'Invalid request URL' }); }

  if (req.method === 'GET' && parsed.pathname === '/api/health')
    return sendJSON(res, 200, { status:'ok', app:'iBroadcast', version:'2.0' });

  if (req.method === 'GET' && parsed.pathname === '/') {
    const file = path.join(__dirname, 'index.html');
    if (!fs.existsSync(file)) return sendJSON(res, 500, { error:'index.html missing from project root' });
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }

  if (req.method === 'POST' && parsed.pathname === '/api/analyze') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        if (typeof data.url !== 'string') throw new Error('একটি media URL দিন।');
        sendJSON(res, 200, await probe(data.url));
      } catch (error) {
        if (!res.headersSent) sendJSON(res, 400, { error:error.message || 'Analyze failed' });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/download') {
    const raw = parsed.searchParams.get('url');
    if (!raw) return sendJSON(res, 400, { error:'Missing URL' });
    try {
      let current = (await probe(raw)).url;
      for (let i = 0; i < 5; i++) {
        const { url, ip } = await validate(current);
        const { res: upstream } = await requestPinned(url, ip, 'GET');
        if ([301,302,303,307,308].includes(upstream.statusCode) && upstream.headers.location) {
          current = new URL(upstream.headers.location, url).href;
          upstream.resume();
          continue;
        }
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          const status = upstream.statusCode;
          upstream.resume();
          if (status === 429) throw new Error('Source server সাময়িকভাবে HTTP 429 দিয়েছে। পরে চেষ্টা করুন।');
          throw new Error(`Download source HTTP ${status}`);
        }
        const type = String(upstream.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
        const length = Number(upstream.headers['content-length'] || 0);
        if (!TYPES.has(type)) { upstream.resume(); throw new Error('Unsupported file type'); }
        if (length > MAX) { upstream.resume(); throw new Error('File exceeds 250 MB'); }
        const info = await probe(raw);
        const headers = {
          'Content-Type': type,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`,
          'X-Content-Type-Options':'nosniff',
          'Cache-Control':'no-store'
        };
        if (length) headers['Content-Length'] = length;
        res.writeHead(200, headers);
        upstream.on('error', () => res.destroy());
        upstream.pipe(res);
        return;
      }
      throw new Error('Too many redirects');
    } catch (error) {
      if (!res.headersSent) sendJSON(res, 400, { error:error.message || 'Download failed' });
      else res.destroy();
    }
    return;
  }

  sendJSON(res, 404, { error:'Not found' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`iBroadcast listening on ${PORT}`));
