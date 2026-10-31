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
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/ogg',
  'application/octet-stream'
]);

function privateIP(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
    const p = ip.split('.').map(Number);

    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }

  if (version === 6) {
    const s = ip.toLowerCase();

    if (s.startsWith('::ffff:')) {
      const mapped = s.slice(7);
      if (net.isIP(mapped) === 4) return privateIP(mapped);
    }

    return (
      s === '::' ||
      s === '::1' ||
      s.startsWith('fc') ||
      s.startsWith('fd') ||
      /^fe[89ab]/.test(s) ||
      s.startsWith('::ffff:')
    );
  }

  return true;
}

async function validate(raw) {
  let url;

  try {
    url = new URL(raw);
  } catch {
    throw Error('লিংকটি সঠিক URL নয়।');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw Error('শুধু public HTTP/HTTPS direct file link গ্রহণ করা হয়।');
  }

  if (
    !url.hostname ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost')
  ) {
    throw Error('Private address অনুমোদিত নয়।');
  }

  let ips;

  try {
    ips = net.isIP(url.hostname)
      ? [url.hostname]
      : (await dns.lookup(url.hostname, {
          all: true,
          verbatim: true
        })).map(item => item.address);
  } catch {
    throw Error('এই লিংকের DNS address পাওয়া যায়নি।');
  }

  if (!ips.length || ips.some(privateIP)) {
    throw Error('এই host নিরাপদ public address নয়।');
  }

  return {
    url,
    ip: ips[0]
  };
}

function request(url, ip, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(url, {
      method,

      headers: {
        'User-Agent': 'iBroadcast/1.2',
        'Accept': '*/*',
        ...headers
      },

      lookup: (host, options, callback) => {
        if (typeof options === 'function') {
          callback = options;
          options = {};
        }

        const family = net.isIP(ip);

        if (!family) {
          return callback(Error('Invalid IP address'));
        }

        if (options && options.all) {
          callback(null, [
            {
              address: ip,
              family
            }
          ]);
        } else {
          callback(null, ip, family);
        }
      },

      timeout: 20000
    }, response => {
      resolve({
        res: response,
        req
      });
    });

    req.on('timeout', () => {
      req.destroy(Error('Source server timeout.'));
    });

    req.on('error', reject);
    req.end();
  });
}

async function probe(raw, depth = 0) {
  if (depth > 4) {
    throw Error('অতিরিক্ত redirect পাওয়া গেছে।');
  }

  const { url, ip } = await validate(raw);

  const { res } = await request(
    url,
    ip,
    'GET',
    { Range: 'bytes=0-0' }
  );

  if (
    [301, 302, 303, 307, 308].includes(res.statusCode) &&
    res.headers.location
  ) {
    const next = new URL(res.headers.location, url).href;
    res.resume();
    return probe(next, depth + 1);
  }

  const type = String(
    res.headers['content-type'] || 'application/octet-stream'
  )
    .split(';')[0]
    .toLowerCase();

  const size = Number(
    res.headers['content-range']?.split('/').pop() ||
    res.headers['content-length'] ||
    0
  );

  res.destroy();

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw Error(`Source HTTP ${res.statusCode} দিয়েছে।`);
  }

  if (!TYPES.has(type)) {
    throw Error(`এই ফাইলের ধরন সমর্থিত নয়: ${type}`);
  }

  if (size > MAX) {
    throw Error('সর্বোচ্চ ফাইল সাইজ ২৫০ MB।');
  }

  let filename = decodeURIComponent(
    url.pathname.split('/').pop() || 'media-download'
  )
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 120);

  if (!path.extname(filename)) {
    const extensions = {
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/flac': '.flac',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov'
    };

    filename += extensions[type] || '.bin';
  }

  return {
    url: url.href,
    filename,
    extension: path.extname(filename).slice(1).toUpperCase(),
    contentType: type,
    size: size || null
  };
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      status: 'ok',
      app: 'iBroadcast',
      version: '1.2'
    });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const file = path.join(__dirname, 'index.html');

    if (!fs.existsSync(file)) {
      return json(res, 500, {
        error: 'index.html missing from project root'
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });

    return fs.createReadStream(file).pipe(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 16000) {
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');

        if (typeof data.url !== 'string') {
          throw Error('একটি media URL দিন।');
        }

        const result = await probe(data.url);

        json(res, 200, result);
      } catch (error) {
        json(res, 400, {
          error: error.message || 'Analyze failed'
        });
      }
    });

    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/download') {
    const raw = url.searchParams.get('url');

    if (!raw) {
      return json(res, 400, {
        error: 'Missing URL'
      });
    }

    try {
      const info = await probe(raw);
      let current = info.url;

      for (let i = 0; i < 5; i++) {
        const { url: sourceURL, ip } = await validate(current);

        const { res: upstream } = await request(
          sourceURL,
          ip,
          'GET'
        );

        if (
          [301, 302, 303, 307, 308].includes(upstream.statusCode) &&
          upstream.headers.location
        ) {
          current = new URL(
            upstream.headers.location,
            sourceURL
          ).href;

          upstream.resume();
          continue;
        }

        if (
          upstream.statusCode < 200 ||
          upstream.statusCode >= 300
        ) {
          upstream.resume();
          throw Error(`Download source HTTP ${upstream.statusCode}`);
        }

        const type = String(
          upstream.headers['content-type'] ||
          'application/octet-stream'
        )
          .split(';')[0]
          .toLowerCase();

        const length = Number(
          upstream.headers['content-length'] || 0
        );

        if (!TYPES.has(type)) {
          upstream.resume();
          throw Error('Unsupported file type');
        }

        if (length > MAX) {
          upstream.resume();
          throw Error('File exceeds 250 MB');
        }

        const responseHeaders = {
          'Content-Type': type,
          'Content-Disposition':
            `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        };

        if (length > 0) {
          responseHeaders['Content-Length'] = length;
        }

        res.writeHead(200, responseHeaders);

        upstream.on('error', () => res.destroy());
        upstream.pipe(res);

        return;
      }

      throw Error('Too many redirects');

    } catch (error) {
      if (!res.headersSent) {
        json(res, 400, {
          error: error.message || 'Download failed'
        });
      } else {
        res.destroy();
      }
    }

    return;
  }

  json(res, 404, {
    error: 'Not found'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`iBroadcast listening on ${PORT}`);
});
