const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Source constants ─────────────────────────────────────────────────────────
const SRC = 'https://potterflixmovies.vercel.app';

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// Abort fetch after 10 seconds — prevents hanging if upstream is slow
const srcFetch = (url) => fetch(url, {
  headers: HEADERS,
  signal : AbortSignal.timeout(10_000),
});

// ─── Route cache (60s TTL, in-memory) ────────────────────────────────────────
const _CACHE     = new Map();
const _CACHE_TTL = 60_000;

function cacheGet(key) {
  const e = _CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > _CACHE_TTL) { _CACHE.delete(key); return null; }
  return e.val;
}
function cacheSet(key, val) {
  _CACHE.set(key, { val, ts: Date.now() });
  if (_CACHE.size > 300) {                           // prune stale entries
    const now = Date.now();
    _CACHE.forEach((v, k) => { if (now - v.ts > _CACHE_TTL) _CACHE.delete(k); });
  }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractNextData(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,"(.+?)"\]\)/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse(`"${m[1]}"`)); } catch (_) {}
  }
  return parts.join('');
}

function parseFiles(data) {
  const files = [];
  const re = /\{"_id":"([^"]+)","file_unique_id":"([^"]+)","added_at":([\d.]+)[^}]*?"caption":"((?:[^"\\]|\\.)*?)","chat_id":(-?\d+),"episode":(\d+|null),"file_id":"[^"]+","file_name":"([^"]*)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)(?:,"search_content":"[^"]*")?,"season":(\d+|null),"year":(\d+|null)/g;
  let m;
  while ((m = re.exec(data)) !== null) {
    const rawFileName = m[7] || '';
    const caption     = m[4] || '';
    const displayName = caption.length > rawFileName.length
      ? caption
      : (rawFileName.includes(' ') ? rawFileName : (caption || rawFileName));
    files.push({
      id          : m[1],
      fileUniqueId: m[2],
      addedAt     : parseFloat(m[3]),
      caption,
      name        : displayName,
      chatId      : parseInt(m[5]),
      episode     : m[6]  !== 'null' ? parseInt(m[6])  : null,
      size        : parseInt(m[8]),
      languages   : m[9].replace(/"/g, '').split(',').filter(Boolean),
      messageId   : parseInt(m[10]),
      quality     : m[11] !== 'null' ? parseInt(m[11]) : null,
      season      : m[12] !== 'null' ? parseInt(m[12]) : null,
      year        : m[13] !== 'null' ? parseInt(m[13]) : null,
    });
  }

  // Fallback regex
  if (files.length === 0) {
    const re2 = /"_id":"([^"]+)","file_unique_id":"([^"]+)"[^}]*?"caption":"((?:[^"\\]|\\.)*?)"[^}]*?"chat_id":(-?\d+)[^}]*?"file_name":"([^"]*)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)[^}]*?"season":(\d+|null)/g;
    let s;
    while ((s = re2.exec(data)) !== null) {
      const caption = s[3] || '', rawFileName = s[5] || '';
      files.push({
        id: s[1], fileUniqueId: s[2], caption,
        name    : caption.length > rawFileName.length ? caption : (rawFileName || caption),
        chatId  : parseInt(s[4]),
        size    : parseInt(s[6]),
        languages: s[7].replace(/"/g, '').split(',').filter(Boolean),
        messageId: parseInt(s[8]),
        quality : s[9] !== 'null' ? parseInt(s[9]) : null,
        season  : s[10] !== 'null' ? parseInt(s[10]) : null,
      });
    }
  }
  return files;
}

// ─── Device / OS / Browser Parser ────────────────────────────────────────────
function parseUA(ua = '') {
  let device  = 'Unknown Device';
  let os      = 'Unknown OS';
  let browser = 'Unknown Browser';

  // ── OS ──
  if (/Windows NT 10/i.test(ua))        os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows/i.test(ua))         os = 'Windows';
  else if (/Android/i.test(ua)) {
    const v = (ua.match(/Android ([\d.]+)/i) || [])[1] || '';
    os = `Android ${v}`.trim();
  }
  else if (/iPhone OS/i.test(ua)) {
    const v = ((ua.match(/iPhone OS ([\d_]+)/i) || [])[1] || '').replace(/_/g, '.');
    os = `iOS ${v}`.trim();
  }
  else if (/iPad/i.test(ua))    os = 'iPadOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua))   os = 'Linux';

  // ── Device (Android model — richest first) ──
  const isAndroid = /Android/i.test(ua);
  if (isAndroid) {
    // Google Pixel  →  "Pixel 7a", "Pixel 8 Pro"
    const pixel = (ua.match(/Pixel ([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
    if (pixel) {
      device = `Google Pixel ${pixel.trim()}`;
    }
    // Redmi / Xiaomi named models  →  "Redmi Note 12", "Redmi 12C"
    else if (/Redmi/i.test(ua)) {
      const model = (ua.match(/Redmi\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = model ? `Redmi ${model.trim()}` : 'Xiaomi Redmi';
    }
    // POCO  →  "POCO X5 Pro", "POCO M4"
    else if (/POCO/i.test(ua)) {
      const model = (ua.match(/POCO\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = model ? `POCO ${model.trim()}` : 'POCO Phone';
    }
    // Xiaomi Mi series
    else if (/\bXiaomi\b/i.test(ua)) {
      const model = (ua.match(/Xiaomi\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = model ? `Xiaomi ${model.trim()}` : 'Xiaomi';
    }
    // Samsung — decode series from SM-* code
    else if (/SM-([A-Z0-9]+)/i.test(ua)) {
      const code  = (ua.match(/SM-([A-Z0-9]+)/i) || [])[1] || '';
      const first = code[0]?.toUpperCase();
      const series = {
        A: 'Galaxy A-series', G: 'Galaxy S-series', S: 'Galaxy S Ultra',
        M: 'Galaxy M-series', F: 'Galaxy Z-series', N: 'Galaxy Note',
        J: 'Galaxy J-series', T: 'Galaxy Tab',
      };
      device = series[first] ? `Samsung ${series[first]} (SM-${code})` : `Samsung (SM-${code})`;
    }
    // OnePlus
    else if (/OnePlus|ONEPLUS/i.test(ua)) {
      const model = (ua.match(/(?:OnePlus|ONEPLUS)\s?([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = model ? `OnePlus ${model.trim()}` : 'OnePlus';
    }
    // Vivo
    else if (/vivo/i.test(ua)) {
      const model = (ua.match(/vivo\s+([\w]+?)(?:\s+Build|\))/i) || [])[1];
      device = model ? `Vivo ${model.trim()}` : 'Vivo';
    }
    // OPPO / realme
    else if (/OPPO/i.test(ua)) {
      const model = (ua.match(/OPPO\s+([\w]+?)(?:\s+Build|\))/i) || [])[1];
      device = model ? `OPPO ${model.trim()}` : 'OPPO';
    }
    else if (/realme/i.test(ua)) {
      const model = (ua.match(/realme\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = model ? `Realme ${model.trim()}` : 'Realme';
    }
    else { device = 'Android Phone'; }
  }
  else if (/iPhone/i.test(ua)) {
    // iOS version already in `os`, e.g. "iOS 17.2"
    device = `iPhone (${os})`;
  }
  else if (/iPad/i.test(ua))   device = 'iPad';
  else if (/Windows/i.test(ua)) device = 'Windows PC';
  else if (/Mac/i.test(ua))    device = 'Mac';
  else if (/Linux/i.test(ua))  device = 'Linux PC';

  // ── Browser ──
  if (/EdgA?\//i.test(ua))            browser = 'Edge';
  else if (/OPR\//i.test(ua))         browser = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Browser';
  else if (/FBAN|FBIOS/i.test(ua))    browser = 'Facebook App';
  else if (/Instagram/i.test(ua))     browser = 'Instagram';
  else if (/Chrome\/([\d]+)/i.test(ua)) {
    browser = `Chrome ${(ua.match(/Chrome\/([\d]+)/i) || [])[1] || ''}`.trim();
  }
  else if (/Firefox\/([\d]+)/i.test(ua)) {
    browser = `Firefox ${(ua.match(/Firefox\/([\d]+)/i) || [])[1] || ''}`.trim();
  }
  else if (/Safari/i.test(ua)) browser = 'Safari';

  return { device, os, browser };
}

// ─── Timestamp ────────────────────────────────────────────────────────────────
function istTime() {
  return new Date().toLocaleString('en-IN', {
    timeZone : 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
  });
}

// ─── Redis / In-memory store ──────────────────────────────────────────────────
const MEM_LOGS = [];

async function redisCmd(...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(
      `${url}/${args.map(a => encodeURIComponent(a)).join('/')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return (await r.json()).result;
  } catch { return null; }
}

async function saveLog(entry) {
  const str = JSON.stringify(entry);
  if (process.env.UPSTASH_REDIS_REST_URL) {
    await redisCmd('lpush', 'lallu:logs', str);
    await redisCmd('ltrim', 'lallu:logs', '0', '999');
  } else {
    MEM_LOGS.unshift(entry);
    if (MEM_LOGS.length > 1000) MEM_LOGS.pop();
  }
}

async function getLogs(limit = 200) {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const raw = await redisCmd('lrange', 'lallu:logs', '0', String(limit - 1));
    if (!raw) return [];
    return (Array.isArray(raw) ? raw : [])
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
  }
  return MEM_LOGS.slice(0, limit);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Search
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ error: 'Query required' });
  const cKey = `search:${q.toLowerCase().trim()}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    const html = await srcFetch(`${SRC}/search?q=${encodeURIComponent(q)}`).then(r => r.text());
    const data = extractNextData(html);
    const results = [], seen = new Set();
    const re = /"title":"([^"]+)","posterPath":(\"([^"]*?)\"|null),"rating":([\d.]+),"year":"(\d+)","mediaType":"([^"]+)"/g;
    let m;
    while ((m = re.exec(data)) !== null) {
      const key = `${m[1]}-${m[5]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isTV = m[6] === 'tv';
      results.push({
        title    : m[1],
        poster   : m[3] ? `https://image.tmdb.org/t/p/w342${m[3]}` : null,  // w342 = smaller, faster
        rating   : parseFloat(m[4]).toFixed(1),
        year     : m[5],
        mediaType: m[6],
        _href    : isTV
          ? `/${encodeURIComponent(m[1])}`
          : `/${encodeURIComponent(`${m[1]} ${m[5]}`)}/all`,
      });
    }
    const payload = { results, query: q };
    cacheSet(cKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('[search]', err.message);
    res.json({ error: 'Search failed', results: [] });
  }
});

// Seasons
app.get('/api/seasons', async (req, res) => {
  const { title } = req.query;
  if (!title) return res.json({ error: 'Title required' });
  const cKey = `seasons:${title}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    const html = await srcFetch(`${SRC}/${encodeURIComponent(title)}`).then(r => r.text());
    const seasons = [];
    const re = /href="\/[^"\/]+\/(\d+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const s = parseInt(m[1]);
      if (!seasons.includes(s)) seasons.push(s);
    }
    seasons.sort((a, b) => a - b);
    const payload = { seasons, title };
    cacheSet(cKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('[seasons]', err.message);
    res.json({ error: 'Failed to load seasons', seasons: [] });
  }
});

// Episodes
app.get('/api/episodes', async (req, res) => {
  const { title, season } = req.query;
  if (!title || !season) return res.json({ error: 'title and season required' });
  const cKey = `episodes:${title}:${season}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    const html = await srcFetch(`${SRC}/${encodeURIComponent(title)}/${season}`).then(r => r.text());
    const buttons = [];
    const linkRe = /href="(\/[^"]+\/\d+\/([^"]+))"[^>]*>[\s\S]*?<div[^>]*class="[^"]*text-2xl[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href  = m[1];
      const seg   = m[2];
      const label = m[3].replace(/<!--[^>]*-->/g, '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      buttons.push({ label, path: href, seg, isComplete: seg === 'all' });
    }
    const seen   = new Set();
    const unique = buttons.filter(b => { if (seen.has(b.path)) return false; seen.add(b.path); return true; });
    unique.sort((a, b) => {
      if (a.isComplete) return -1;
      if (b.isComplete) return 1;
      return parseInt(a.seg) - parseInt(b.seg);
    });
    const posterMatch = html.match(/image\.tmdb\.org\/t\/p\/w500([^"]+)/);
    const poster = posterMatch ? `https://image.tmdb.org/t/p/w342${posterMatch[1]}` : null;
    const payload = { buttons: unique, poster, title, season: parseInt(season) };
    cacheSet(cKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('[episodes]', err.message);
    res.json({ error: 'Failed to load episodes', buttons: [] });
  }
});

// Files
app.get('/api/files', async (req, res) => {
  const { title, tvPath } = req.query;
  if (!title && !tvPath) return res.json({ error: 'title or tvPath required' });
  const cKey = `files:${tvPath || title}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    let url;
    if (tvPath) {
      const parts = tvPath.split('/');
      url = `${SRC}/${parts.map(p => encodeURIComponent(p)).join('/')}`;
    } else {
      url = `${SRC}/${encodeURIComponent(title)}/all`;
    }
    const html = await srcFetch(url).then(r => r.text());
    const data = extractNextData(html);
    const files = parseFiles(data);
    const posterMatch = data.match(/image\.tmdb\.org\/t\/p\/w500([^"]+)/);
    const poster = posterMatch ? `https://image.tmdb.org/t/p/w342${posterMatch[1]}` : null;
    const payload = { files, poster, title: title || tvPath };
    cacheSet(cKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('[files]', err.message);
    res.json({ error: 'Failed to load files', files: [] });
  }
});

// Track (analytics)
app.post('/api/track', async (req, res) => {
  try {
    const ua = req.headers['user-agent'] || '';
    const { action, data, uid, clientHints } = req.body || {};
    if (!action) return res.json({ ok: false });

    const { device, os, browser } = parseUA(ua);

    // Merge clientHints model if available (Android Chrome sends actual device name)
    let finalDevice = device;
    if (clientHints?.model && clientHints.model.length > 0) {
      finalDevice = clientHints.model;
    }

    const entry = {
      time  : istTime(),
      ts    : Date.now(),
      uid   : uid || null,
      device: finalDevice,
      os,
      browser,
      mobile: clientHints?.mobile ?? /Mobile/i.test(ua),
      action,
      data  : data || {},
    };

    await saveLog(entry);
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

// Admin
app.post('/api/admin', async (req, res) => {
  const { password } = req.body || {};
  const correct = process.env.ADMIN_PASSWORD || 'lallu2024';
  if (password !== correct) return res.status(401).json({ ok: false, error: 'Wrong password' });
  try {
    const logs  = await getLogs(300);
    // Unique users count (distinct non-null uid values)
    const uuids = new Set(logs.map(l => l.uid).filter(Boolean));
    res.json({ ok: true, logs, stats: { uniqueUsers: uuids.size } });
  } catch {
    res.json({ ok: false, error: 'Failed to fetch logs' });
  }
});

// Health
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// SPA catch-all
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Lallu server → http://localhost:${PORT}`));
}
module.exports = app;
