const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Internal source (not exposed to frontend)
const _SRC = 'https://potterflixmovies.vercel.app';
const _DL  = 'https://potterstreaming.mgodyt2.workers.dev';

const _H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// ─── Token Generation Algorithm (reverse-engineered) ───────────────────────
// Params: file_unique_id (first 3 chars), chat_id (without -100), message_id
function generateStreamToken(fileUniqueId, chatId, messageId) {
  // Step 1: Encode expiry time (current + 6 hours) as big-endian uint32
  const expiry = Math.floor(Date.now() / 1000) + 21600;
  const timeBuf = new ArrayBuffer(4);
  const timeView = new DataView(timeBuf);
  timeView.setUint32(0, expiry, false); // big-endian
  const timePart = bufToBase64Url(new Uint8Array(timeBuf));

  // Step 2: First 3 chars of file_unique_id
  const prefix = fileUniqueId ? fileUniqueId.substring(0, 3) : 'xxx';

  // Step 3: Encode chat_id + message_id as two big-endian uint32s
  const cleanChatId = parseInt(chatId.toString().replace('-100', ''), 10) || 0;
  const msgBuf = new ArrayBuffer(8);
  const msgView = new DataView(msgBuf);
  msgView.setUint32(0, cleanChatId, false);
  msgView.setUint32(4, messageId, false);
  const msgPart = bufToBase64Url(new Uint8Array(msgBuf));

  // Token = prefix + timePart + msgPart
  return prefix + timePart + msgPart;
}

function bufToBase64Url(bytes) {
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return Buffer.from(str, 'binary')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─── Extract Next.js RSC data ───────────────────────────────────────────────
function extractNextData(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,"(.+?)"\]\)/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse(`"${m[1]}"`)); } catch(e) {}
  }
  return parts.join('');
}

// ─── Search API ─────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ error: 'Query required' });

  try {
    const html = await fetch(`${_SRC}/search?q=${encodeURIComponent(q)}`, { headers: _H }).then(r => r.text());
    const data = extractNextData(html);
    const results = [];
    const seen = new Set();

    // Parse from SSR JSON data embedded in page
    const re = /"title":"([^"]+)","posterPath":("([^"]*?)"|null),"rating":([\d.]+),"year":"(\d+)","mediaType":"([^"]+)"/g;
    let m;
    while ((m = re.exec(data)) !== null) {
      const key = `${m[1]}-${m[5]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        title: m[1],
        poster: m[3] ? `https://image.tmdb.org/t/p/w500${m[3]}` : null,
        rating: parseFloat(m[4]).toFixed(1),
        year: m[5],
        mediaType: m[6],
        // internal href — used to fetch files
        _href: m[6] === 'tv' 
          ? `/${encodeURIComponent(m[1])}` 
          : `/${encodeURIComponent(`${m[1]} ${m[5]}`)}/all`,
      });
    }

    res.json({ results, query: q });
  } catch (err) {
    console.error('[search]', err.message);
    res.json({ error: 'Search failed' });
  }
});

// ─── Files API ──────────────────────────────────────────────────────────────
app.get('/api/files', async (req, res) => {
  const { title } = req.query;
  if (!title) return res.json({ error: 'Title required' });

  try {
    const url = `${_SRC}/${encodeURIComponent(title)}/all`;
    const html = await fetch(url, { headers: _H }).then(r => r.text());
    const data = extractNextData(html);

    const files = [];

    // Parse full file objects — we need file_unique_id, chat_id, message_id for token gen
    // Match individual file JSON objects
    const fileRe = /\{"_id":"([^"]+)","file_unique_id":"([^"]+)","added_at":([\d.]+)[^}]*?"caption":"((?:[^"\\]|\\.)*)","chat_id":(-?\d+),"episode":(\d+|null),"file_id":"[^"]+","file_name":"([^"]+)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)(?:,"search_content":"[^"]*")?,"season":(\d+|null),"year":(\d+|null)/g;
    let m;
    while ((m = fileRe.exec(data)) !== null) {
      files.push({
        id: m[1],
        fileUniqueId: m[2],
        addedAt: parseFloat(m[3]),
        name: m[7],
        size: parseInt(m[8]),
        languages: m[9].replace(/"/g, '').split(',').filter(Boolean),
        chatId: parseInt(m[5]),
        messageId: parseInt(m[10]),
        quality: m[11] !== 'null' ? parseInt(m[11]) : null,
        episode: m[6] !== 'null' ? parseInt(m[6]) : null,
        season: m[12] !== 'null' ? parseInt(m[12]) : null,
        year: m[13] !== 'null' ? parseInt(m[13]) : null,
      });
    }

    // Fallback: simpler regex if above fails
    if (files.length === 0) {
      const simple = /"_id":"([^"]+)","file_unique_id":"([^"]+)"[^}]*?"chat_id":(-?\d+)[^}]*?"file_name":"([^"]+)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)[^}]*?"season":(\d+|null)/g;
      let s;
      while ((s = simple.exec(data)) !== null) {
        files.push({
          id: s[1],
          fileUniqueId: s[2],
          chatId: parseInt(s[3]),
          name: s[4],
          size: parseInt(s[5]),
          languages: s[6].replace(/"/g, '').split(',').filter(Boolean),
          messageId: parseInt(s[7]),
          quality: s[8] !== 'null' ? parseInt(s[8]) : null,
          season: s[9] !== 'null' ? parseInt(s[9]) : null,
        });
      }
    }

    // Extract poster
    const posterMatch = data.match(/image\.tmdb\.org\/t\/p\/w500([^"]+)/);
    const poster = posterMatch ? `https://image.tmdb.org/t/p/w500${posterMatch[1]}` : null;

    res.json({ files, poster, title });
  } catch (err) {
    console.error('[files]', err.message);
    res.json({ error: 'Failed to load files' });
  }
});

// ─── Generate Direct Download Link ──────────────────────────────────────────
// This uses the reverse-engineered token algorithm — no external calls needed
app.post('/api/gen-link', async (req, res) => {
  const { fileUniqueId, chatId, messageId } = req.body;

  if (!fileUniqueId || !chatId || !messageId) {
    return res.json({ success: false, error: 'Missing params' });
  }

  try {
    const token = generateStreamToken(fileUniqueId, chatId, messageId);
    const directUrl = `${_DL}/${token}`;
    
    res.json({
      success: true,
      token,
      url: directUrl,
      expiresIn: 6 * 60 * 60, // seconds
    });
  } catch (err) {
    console.error('[gen-link]', err.message);
    res.json({ success: false, error: 'Token generation failed' });
  }
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ─── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
}

module.exports = app;
