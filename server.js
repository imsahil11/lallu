const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const _SRC = 'https://potterflixmovies.vercel.app';
const _DL  = 'https://potterstreaming.mgodyt2.workers.dev';

const _H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// ─── Token Generation ────────────────────────────────────────────────────────
function generateStreamToken(fileUniqueId, chatId, messageId) {
  const expiry = Math.floor(Date.now() / 1000) + 21600;
  const timeBuf = new ArrayBuffer(4);
  new DataView(timeBuf).setUint32(0, expiry, false);
  const timePart = bufToBase64Url(new Uint8Array(timeBuf));
  const prefix = fileUniqueId ? fileUniqueId.substring(0, 3) : 'xxx';
  const cleanChatId = parseInt(chatId.toString().replace('-100', ''), 10) || 0;
  const msgBuf = new ArrayBuffer(8);
  const msgView = new DataView(msgBuf);
  msgView.setUint32(0, cleanChatId, false);
  msgView.setUint32(4, messageId, false);
  const msgPart = bufToBase64Url(new Uint8Array(msgBuf));
  return prefix + timePart + msgPart;
}

function bufToBase64Url(bytes) {
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return Buffer.from(str, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Extract Next.js RSC data ────────────────────────────────────────────────
function extractNextData(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,"(.+?)"\]\)/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse(`"${m[1]}"`)); } catch(e) {}
  }
  return parts.join('');
}

// ─── Parse files ─────────────────────────────────────────────────────────────
function parseFiles(data) {
  const files = [];
  const fileRe = /\{"_id":"([^"]+)","file_unique_id":"([^"]+)","added_at":([\d.]+)[^}]*?"caption":"((?:[^"\\]|\\.)*?)","chat_id":(-?\d+),"episode":(\d+|null),"file_id":"[^"]+","file_name":"([^"]*)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)(?:,"search_content":"[^"]*")?,"season":(\d+|null),"year":(\d+|null)/g;
  let m;
  while ((m = fileRe.exec(data)) !== null) {
    const rawFileName = m[7] || '';
    const caption     = m[4] || '';
    // caption is always richer — use it when longer, else use file_name
    const displayName = caption.length > rawFileName.length
      ? caption
      : (rawFileName.includes(' ') ? rawFileName : (caption || rawFileName));

    files.push({
      id: m[1], fileUniqueId: m[2], addedAt: parseFloat(m[3]),
      caption, name: displayName,
      size: parseInt(m[8]),
      languages: m[9].replace(/"/g, '').split(',').filter(Boolean),
      chatId: parseInt(m[5]), messageId: parseInt(m[10]),
      quality: m[11] !== 'null' ? parseInt(m[11]) : null,
      episode: m[6] !== 'null' ? parseInt(m[6]) : null,
      season: m[12] !== 'null' ? parseInt(m[12]) : null,
      year: m[13] !== 'null' ? parseInt(m[13]) : null,
    });
  }

  // Fallback
  if (files.length === 0) {
    const simple = /"_id":"([^"]+)","file_unique_id":"([^"]+)"[^}]*?"caption":"((?:[^"\\]|\\.)*?)"[^}]*?"chat_id":(-?\d+)[^}]*?"file_name":"([^"]*)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)[^}]*?"season":(\d+|null)/g;
    let s;
    while ((s = simple.exec(data)) !== null) {
      const caption = s[3] || '', rawFileName = s[5] || '';
      files.push({
        id: s[1], fileUniqueId: s[2], caption,
        name: caption.length > rawFileName.length ? caption : (rawFileName || caption),
        chatId: parseInt(s[4]), size: parseInt(s[6]),
        languages: s[7].replace(/"/g, '').split(',').filter(Boolean),
        messageId: parseInt(s[8]),
        quality: s[9] !== 'null' ? parseInt(s[9]) : null,
        season: s[10] !== 'null' ? parseInt(s[10]) : null,
      });
    }
  }
  return files;
}

// ─── Search API ──────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ error: 'Query required' });
  try {
    const html = await fetch(`${_SRC}/search?q=${encodeURIComponent(q)}`, { headers: _H }).then(r => r.text());
    const data = extractNextData(html);
    const results = [], seen = new Set();
    const re = /"title":"([^"]+)","posterPath":("([^"]*?)"|null),"rating":([\d.]+),"year":"(\d+)","mediaType":"([^"]+)"/g;
    let m;
    while ((m = re.exec(data)) !== null) {
      const key = `${m[1]}-${m[5]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isTV = m[6] === 'tv';
      results.push({
        title: m[1],
        poster: m[3] ? `https://image.tmdb.org/t/p/w500${m[3]}` : null,
        rating: parseFloat(m[4]).toFixed(1),
        year: m[5], mediaType: m[6],
        _href: isTV ? `/${encodeURIComponent(m[1])}` : `/${encodeURIComponent(`${m[1]} ${m[5]}`)}/all`,
      });
    }
    res.json({ results, query: q });
  } catch (err) {
    console.error('[search]', err.message);
    res.json({ error: 'Search failed' });
  }
});

// ─── Seasons API ─────────────────────────────────────────────────────────────
// Fetches /Title → returns season numbers
app.get('/api/seasons', async (req, res) => {
  const { title } = req.query;
  if (!title) return res.json({ error: 'Title required' });
  try {
    const html = await fetch(`${_SRC}/${encodeURIComponent(title)}`, { headers: _H }).then(r => r.text());
    const seasons = [];
    const re = /href="\/[^"\/]+\/(\d+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const s = parseInt(m[1]);
      if (!seasons.includes(s)) seasons.push(s);
    }
    seasons.sort((a, b) => a - b);
    res.json({ seasons, title });
  } catch (err) {
    console.error('[seasons]', err.message);
    res.json({ error: 'Failed to load seasons', seasons: [] });
  }
});

// ─── Episodes API ────────────────────────────────────────────────────────────
// Fetches /Title/Season page — scrapes EXACT button labels & paths from Potterflix.
// Returns: { buttons: [{label, path, isComplete}], poster }
// This mirrors what Potterflix actually renders, so labels are never hardcoded.
app.get('/api/episodes', async (req, res) => {
  const { title, season } = req.query;
  if (!title || !season) return res.json({ error: 'title and season required' });
  try {
    const html = await fetch(`${_SRC}/${encodeURIComponent(title)}/${season}`, { headers: _H }).then(r => r.text());

    const buttons = [];

    // Potterflix renders cards like:
    //   <a href="/Mirzapur/2/all">...<div>Complete Season</div>...</a>
    //   <a href="/Mirzapur/2/1">...<div>Episode 1</div>...</a>
    // We match href + the text inside the innermost <div> of that card.
    const linkRe = /href="(\/[^"]+\/\d+\/([^"]+))"[^>]*>[\s\S]*?<div[^>]*class="[^"]*text-2xl[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href  = m[1];           // e.g. /Mirzapur/2/all or /Mirzapur/2/1
      const seg   = m[2];           // "all" or "1"
      // Clean up label: strip HTML comments, trim whitespace
      const label = m[3].replace(/<!--[^>]*-->/g, '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      const isComplete = seg === 'all';
      buttons.push({ label, path: href, seg, isComplete });
    }

    // Deduplicate by path
    const seen = new Set();
    const unique = buttons.filter(b => { if (seen.has(b.path)) return false; seen.add(b.path); return true; });

    // Sort: complete first, then episodes by number
    unique.sort((a, b) => {
      if (a.isComplete) return -1;
      if (b.isComplete) return 1;
      return parseInt(a.seg) - parseInt(b.seg);
    });

    const posterMatch = html.match(/image\.tmdb\.org\/t\/p\/w500([^"]+)/);
    const poster = posterMatch ? `https://image.tmdb.org/t/p/w500${posterMatch[1]}` : null;

    res.json({ buttons: unique, poster, title, season: parseInt(season) });
  } catch (err) {
    console.error('[episodes]', err.message);
    res.json({ error: 'Failed to load episodes', buttons: [] });
  }
});

// ─── Files API ───────────────────────────────────────────────────────────────
// ?title=Movie Year   → /{title}/all
// ?tvPath=Title/2/all → fetches that exact path
app.get('/api/files', async (req, res) => {
  const { title, tvPath } = req.query;
  if (!title && !tvPath) return res.json({ error: 'title or tvPath required' });
  try {
    let url;
    if (tvPath) {
      const parts = tvPath.split('/');
      url = `${_SRC}/${parts.map(p => encodeURIComponent(p)).join('/')}`;
    } else {
      url = `${_SRC}/${encodeURIComponent(title)}/all`;
    }
    const html = await fetch(url, { headers: _H }).then(r => r.text());
    const data = extractNextData(html);
    const files = parseFiles(data);
    const posterMatch = data.match(/image\.tmdb\.org\/t\/p\/w500([^"]+)/);
    const poster = posterMatch ? `https://image.tmdb.org/t/p/w500${posterMatch[1]}` : null;
    res.json({ files, poster, title: title || tvPath });
  } catch (err) {
    console.error('[files]', err.message);
    res.json({ error: 'Failed to load files' });
  }
});

// ─── Generate Link ───────────────────────────────────────────────────────────
app.post('/api/gen-link', async (req, res) => {
  const { fileUniqueId, chatId, messageId } = req.body;
  if (!fileUniqueId || !chatId || !messageId)
    return res.json({ success: false, error: 'Missing params' });
  try {
    const token = generateStreamToken(fileUniqueId, chatId, messageId);
    res.json({ success: true, token, url: `${_DL}/${token}`, expiresIn: 21600 });
  } catch (err) {
    console.error('[gen-link]', err.message);
    res.json({ success: false, error: 'Token generation failed' });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
}
module.exports = app;
