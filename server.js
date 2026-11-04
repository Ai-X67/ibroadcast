'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');

let ytdl = null;
try {
  ytdl = require('@distube/ytdl-core');
} catch {
  console.warn('Optional @distube/ytdl-core not loaded, using cloud fallback engines.');
}

const PORT = Number(process.env.PORT || 10000);
const MAX = 400 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt.api.timelessnesses.me',
  'https://api.cobalt.best',
  'https://co.eepy.today'
];

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.syncpundit.io',
  'https://api.piped.private.coffee'
];

const INVIDIOUS_INSTANCES = [
  'https://inv.tux.pizza',
  'https://invidious.nerdvpn.de',
  'https://invidious.privacyredirect.com'
];

function detectPlatform(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(h)) return 'youtube';
    if (h.includes('instagram.com')) return 'instagram';
    if (h.includes('tiktok.com')) return 'tiktok';
    if (h.includes('facebook.com') || h.includes('fb.watch')) return 'facebook';
    if (h.includes('twitter.com') || h.includes('x.com')) return 'twitter';
    if (h.includes('soundcloud.com')) return 'soundcloud';
    return 'direct';
  } catch {
    return 'invalid';
  }
}

function extractYouTubeId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'live', 'v'].includes(parts[0]) && parts[1]) return parts[1];
    return null;
  } catch {
    return null;
  }
}

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

async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('লিংকটি সঠিক URL নয়।'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('শুধুমাত্র পাবলিক HTTP/HTTPS লিংক গ্রহণযোগ্য।');
  }
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
    throw new Error('লোকাল বা প্রাইভেট অ্যাড্রেস গ্রহণযোগ্য নয়।');
  }
  let addresses;
  try {
    addresses = net.isIP(url.hostname)
      ? [url.hostname]
      : (await dns.lookup(url.hostname, { all: true, verbatim: true })).map(x => x.address);
  } catch {
    throw new Error('এই লিংকের সার্ভার খুঁজে পাওয়া যায়নি (DNS Error)।');
  }
  if (!addresses.length || addresses.some(isPrivateIP)) {
    throw new Error('নিরাপত্তার কারণে প্রাইভেট IP ব্লক করা হয়েছে।');
  }
  return { url, ip: addresses[0] };
}

function safeFilename(name, ext) {
  const clean = String(name || 'media_file')
    .replace(/[^a-zA-Z0-9_\-\. ]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 95) || 'media_file';
  const cleanExt = String(ext || 'mp4').replace(/^\./, '').toLowerCase();
  return clean.toLowerCase().endsWith('.' + cleanExt) ? clean : `${clean}.${cleanExt}`;
}

async function fetchJSON(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function tryCobaltExtract(targetUrl, mode = 'auto') {
  const isAudioOnly = mode === 'audio' || targetUrl.includes('music.youtube.com');

  for (const instance of COBALT_INSTANCES) {
    try {
      const v10Payload = {
        url: targetUrl,
        downloadMode: isAudioOnly ? 'audio' : 'auto',
        audioFormat: 'mp3',
        videoQuality: '720'
      };
      const data = await fetchJSON(`${instance}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(v10Payload)
      }, 10000).catch(async () => {
        const v7Payload = {
          url: targetUrl,
          isAudioOnly: isAudioOnly,
          aFormat: 'mp3',
          vQuality: '720'
        };
        return await fetchJSON(`${instance}/api/json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(v7Payload)
        }, 10000);
      });

      const streamUrl = data?.url || (Array.isArray(data?.picker) && data.picker[0]?.url);
      if (streamUrl) {
        const ext = isAudioOnly ? 'mp3' : 'mp4';
        const contentType = isAudioOnly ? 'audio/mpeg' : 'video/mp4';
        const rawTitle = data.filename || `${detectPlatform(targetUrl)}_${Date.now()}`;
        const filename = safeFilename(rawTitle.replace(/\.[a-z0-9]{2,4}$/i, ''), ext);
        return {
          url: targetUrl,
          streamUrl,
          filename,
          extension: ext.toUpperCase(),
          contentType,
          size: null,
          platform: detectPlatform(targetUrl),
          engine: 'cobalt'
        };
      }
    } catch {}
  }
  throw new Error('Cobalt instances busy');
}

async function tryYouTubeApiExtract(rawUrl, mode = 'auto') {
  const videoId = extractYouTubeId(rawUrl);
  if (!videoId) throw new Error('Invalid YouTube video ID');
  const wantAudio = mode === 'audio' || rawUrl.includes('music.youtube.com');

  for (const api of PIPED_INSTANCES) {
    try {
      const data = await fetchJSON(`${api}/streams/${videoId}`, {}, 10000);
      if (!data) continue;

      let chosen = null;
      if (wantAudio && Array.isArray(data.audioStreams) && data.audioStreams.length) {
        chosen = data.audioStreams.find(s => s.mimeType?.includes('mp4')) || data.audioStreams[0];
      } else if (Array.isArray(data.videoStreams) && data.videoStreams.length) {
        chosen = data.videoStreams.find(s => !s.videoOnly && s.mimeType?.includes('mp4')) ||
                 data.audioStreams?.[0] ||
                 data.videoStreams[0];
      }

      if (chosen && chosen.url) {
        const isAudio = wantAudio || !chosen.quality;
        const ext = isAudio ? 'm4a' : 'mp4';
        const contentType = isAudio ? 'audio/mp4' : 'video/mp4';
        return {
          url: rawUrl,
          streamUrl: chosen.url,
          filename: safeFilename(data.title || `youtube_${videoId}`, ext),
          extension: ext.toUpperCase(),
          contentType,
          size: Number(chosen.contentLength || 0) || null,
          platform: 'youtube',
          engine: 'piped'
        };
      }
    } catch {}
  }

  for (const inv of INVIDIOUS_INSTANCES) {
    try {
      const data = await fetchJSON(`${inv}/api/v1/videos/${videoId}`, {}, 10000);
      if (!data) continue;

      const adaptive = Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : [];
      const combined = Array.isArray(data.formatStreams) ? data.formatStreams : [];
      let chosen = null;

      if (wantAudio) {
        chosen = adaptive.find(f => f.type?.startsWith('audio/mp4')) || adaptive.find(f => f.type?.startsWith('audio/'));
      } else {
        chosen = combined.find(f => f.type?.startsWith('video/mp4')) || combined[0] || adaptive.find(f => f.type?.startsWith('audio/'));
      }

      if (chosen && chosen.url) {
        const isAudio = chosen.type?.startsWith('audio/');
        const ext = isAudio ? 'm4a' : 'mp4';
        return {
          url: rawUrl,
          streamUrl: chosen.url,
          filename: safeFilename(data.title || `youtube_${videoId}`, ext),
          extension: ext.toUpperCase(),
          contentType: isAudio ? 'audio/mp4' : 'video/mp4',
          size: Number(chosen.clen || 0) || null,
          platform: 'youtube',
          engine: 'invidious'
        };
      }
    } catch {}
  }

  throw new Error('YouTube API nodes unreachable');
}

async function tryYtdlCoreExtract(rawUrl, mode = 'auto') {
  if (!ytdl) throw new Error('ytdl-core not installed');
  const wantAudio = mode === 'audio' || rawUrl.includes('music.youtube.com');
  const info = await ytdl.getInfo(rawUrl);
  const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
  const combinedFormats = ytdl.filterFormats(info.formats, 'audioandvideo');

  let format = null;
  if (wantAudio && audioFormats.length) {
    format = audioFormats.find(f => f.container === 'm4a' || f.container === 'mp4') || audioFormats[0];
  } else if (combinedFormats.length) {
    format = combinedFormats.find(f => f.container === 'mp4') || combinedFormats[0];
  } else if (audioFormats.length) {
    format = audioFormats[0];
  }

  if (!format || !format.url) throw new Error('No direct format found');
  const isAudio = !format.hasVideo;
  const ext = isAudio ? 'm4a' : (format.container || 'mp4');
  return {
    url: rawUrl,
    streamUrl: format.url,
    filename: safeFilename(info.videoDetails?.title || 'youtube_track', ext),
    extension: ext.toUpperCase(),
    contentType: isAudio ? 'audio/mp4' : `video/${ext}`,
    size: Number(format.contentLength || 0) || null,
    platform: 'youtube',
    engine: 'ytdl'
  };
}

async function tryTikWMExtract(rawUrl, mode = 'auto') {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(rawUrl)}`;
  const res = await fetchJSON(apiUrl, {}, 10000);
  if (res?.code !== 0 || !res?.data) throw new Error('TikTok API failed');

  const d = res.data;
  const wantAudio = mode === 'audio';
  const streamUrl = wantAudio ? (d.music || d.play) : (d.play || d.wmplay);
  if (!streamUrl) throw new Error('No TikTok stream found');

  const ext = wantAudio ? 'mp3' : 'mp4';
  return {
    url: rawUrl,
    streamUrl,
    filename: safeFilename(d.title || `tiktok_${d.id || Date.now()}`, ext),
    extension: ext.toUpperCase(),
    contentType: wantAudio ? 'audio/mpeg' : 'video/mp4',
    size: Number(d.size || 0) || null,
    platform: 'tiktok',
    engine: 'tikwm'
  };
}

function requestPinned(url, ip, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers },
      lookup: (hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        const family = net.isIP(ip);
        if (!family) return callback(new Error('Invalid IP'));
        if (options && options.all) callback(null, [{ address: ip, family }]);
        else callback(null, ip, family);
      },
      timeout: 20000
    }, res => resolve({ res, req }));
    req.on('timeout', () => req.destroy(new Error('Source server timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function probeDirectLink(rawUrl, depth = 0) {
  if (depth > 5) throw new Error('অতিরিক্ত Redirect পাওয়া গেছে।');
  const { url, ip } = await validatePublicUrl(rawUrl);
  const { res } = await requestPinned(url, ip, 'GET', { Range: 'bytes=0-0' });

  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    const next = new URL(res.headers.location, url).href;
    res.resume();
    return probeDirectLink(next, depth + 1);
  }

  const status = res.statusCode;
  const type = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
  const size = Number(res.headers['content-range']?.split('/').pop() || res.headers['content-length'] || 0);
  res.destroy();

  if (status < 200 || status >= 400) {
    throw new Error(`সোর্স সার্ভার HTTP ${status} দিয়েছে।`);
  }
  if (type.includes('text/html')) {
    throw new Error('এটি একটি ওয়েবপেজ লিংক, সরাসরি মিডিয়া ফাইল নয়।');
  }
  if (size > MAX) throw new Error('ফাইলের সাইজ ৪০০ MB-এর বেশি।');

  const rawName = decodeURIComponent(url.pathname.split('/').pop() || 'direct_media');
  const extMap = {
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
    'audio/flac': 'flac', 'video/mp4': 'mp4', 'video/webm': 'webm'
  };
  const existingExt = path.extname(rawName).slice(1).toLowerCase();
  const ext = existingExt || extMap[type] || 'mp4';

  return {
    url: url.href,
    streamUrl: url.href,
    filename: safeFilename(rawName.replace(/\.[a-z0-9]{2,5}$/i, ''), ext),
    extension: ext.toUpperCase(),
    contentType: type === 'application/octet-stream' ? (ext === 'mp3' ? 'audio/mpeg' : 'video/mp4') : type,
    size: size || null,
    platform: 'direct',
    engine: 'direct'
  };
}

async function resolveMedia(rawUrl, mode = 'auto') {
  await validatePublicUrl(rawUrl);
  const platform = detectPlatform(rawUrl);

  if (platform === 'tiktok') {
    try { return await tryTikWMExtract(rawUrl, mode); } catch {}
    try { return await tryCobaltExtract(rawUrl, mode); } catch {}
    throw new Error('TikTok ভিডিওটি এই মুহূর্তে এক্সট্রাক্ট করা যাচ্ছে না।');
  }

  if (platform === 'youtube') {
    const strategies = [
      () => tryCobaltExtract(rawUrl, mode),
      () => tryYouTubeApiExtract(rawUrl, mode),
      () => tryYtdlCoreExtract(rawUrl, mode)
    ];
    for (const fn of strategies) {
      try {
        const res = await fn();
        if (res && res.streamUrl) return res;
      } catch {}
    }
    throw new Error('YouTube সার্ভারের গেটওয়ে ব্যস্ত রয়েছে। কিছুক্ষণ পর চেষ্টা করুন।');
  }

  if (['instagram', 'facebook', 'twitter', 'soundcloud'].includes(platform)) {
    try { return await tryCobaltExtract(rawUrl, mode); } catch {}
    throw new Error(`${platform.toUpperCase()} লিংকটি এক্সট্রাক্ট করা যায়নি।`);
  }

  try {
    return await probeDirectLink(rawUrl);
  } catch (directErr) {
    try {
      return await tryCobaltExtract(rawUrl, mode);
    } catch {
      throw directErr;
    }
  }
}

const sendJSON = (res, status, data) => {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  let parsed;
  try { parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendJSON(res, 400, { error: 'Invalid request URL' }); }

  if (req.method === 'GET' && parsed.pathname === '/api/health') {
    return sendJSON(res, 200, { status: 'ok', app: 'iBroadcast', version: '3.0.1' });
  }

  if (req.method === 'GET' && parsed.pathname === '/') {
    const file = path.join(__dirname, 'index.html');
    if (!fs.existsSync(file)) return sendJSON(res, 500, { error: 'index.html missing' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
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
        if (typeof data.url !== 'string' || !data.url.trim()) {
          throw new Error('একটি মিডিয়া বা সোশ্যাল লিংক দিন।');
        }
        const mode = ['audio', 'video', 'auto'].includes(data.mode) ? data.mode : 'auto';
        const result = await resolveMedia(data.url.trim(), mode);
        sendJSON(res, 200, result);
      } catch (error) {
        sendJSON(res, 400, { error: error.message || 'লিংকটি ভেরিফাই করা যায়নি।' });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/download') {
    const rawUrl = parsed.searchParams.get('url');
    const directStream = parsed.searchParams.get('stream');
    const customName = parsed.searchParams.get('name') || 'media_download.mp4';
    const customMime = parsed.searchParams.get('mime') || 'application/octet-stream';
    const mode = parsed.searchParams.get('mode') || 'auto';

    if (!rawUrl && !directStream) return sendJSON(res, 400, { error: 'Missing download target' });

    try {
      let targetStreamUrl = directStream;
      let filename = customName;
      let contentType = customMime;

      if (!targetStreamUrl) {
        const info = await resolveMedia(rawUrl, mode);
        targetStreamUrl = info.streamUrl;
        filename = info.filename;
        contentType = info.contentType;
      }

      let current = targetStreamUrl;
      const clientRange = req.headers['range'];

      for (let i = 0; i < 6; i++) {
        const { url, ip } = await validatePublicUrl(current);
        const reqHeaders = { 'Referer': url.origin + '/' };
        if (clientRange) reqHeaders['Range'] = clientRange;

        const { res: upstream } = await requestPinned(url, ip, 'GET', reqHeaders);

        if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
          current = new URL(upstream.headers.location, url).href;
          upstream.resume();
          continue;
        }

        if (upstream.statusCode < 200 || upstream.statusCode >= 400) {
          const st = upstream.statusCode;
          upstream.resume();
          if (directStream && rawUrl && i === 0) {
            const fresh = await resolveMedia(rawUrl, mode);
            current = fresh.streamUrl;
            continue;
          }
          throw new Error(`Upstream HTTP ${st}`);
        }

        const upType = String(upstream.headers['content-type'] || contentType).split(';')[0].toLowerCase();
        const length = Number(upstream.headers['content-length'] || 0);

        const headers = {
          'Content-Type': upType.includes('text/html') ? contentType : upType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Accept-Ranges': 'bytes'
        };
        if (length) headers['Content-Length'] = length;
        if (upstream.headers['content-range']) headers['Content-Range'] = upstream.headers['content-range'];

        res.writeHead(upstream.statusCode === 206 ? 206 : 200, headers);
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        upstream.on('error', () => { if (!res.writableEnded) res.destroy(); });
        upstream.pipe(res);
        return;
      }
      throw new Error('Too many redirects while streaming');
    } catch (error) {
      if (!res.headersSent) sendJSON(res, 400, { error: error.message || 'Download failed' });
      else res.destroy();
    }
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`iBroadcast 3.0 Universal Server listening on ${PORT}`));

