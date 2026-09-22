const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PF    = 'https://potterflixmovies.vercel.app';

// potterflix — extract RSC streamed json chunks from rendered page
function extractNextData(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,"(.+?)"\]\)/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse(`"${m[1]}"`)); } catch (_) {}
  }
  return parts.join('');
}

// potterflix — parse file objects from RSC json string
function parseFiles(data) {
  const files = [];
  const re = /\{"_id":"([^"]+)","file_unique_id":"([^"]+)","added_at":([\d.]+)[^}]*?"caption":"((?:[^"\\]|\\.)*?)","chat_id":(-?\d+),"episode":(\d+|null),"file_id":"[^"]+","file_name":"([^"]*)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)(?:,"search_content":"[^"]*")?,"season":(\d+|null),"year":(\d+|null)/g;
  let m;
  while ((m = re.exec(data)) !== null) {
    const rawFileName = m[7] || '';
    const caption     = m[4] || '';
    const displayName = caption.length > rawFileName.length
      ? caption : (rawFileName.includes(' ') ? rawFileName : (caption || rawFileName));
    files.push({
      id: m[1], fileUniqueId: m[2], addedAt: parseFloat(m[3]),
      caption, name: displayName,
      chatId: parseInt(m[5]),
      episode: m[6] !== 'null' ? parseInt(m[6]) : null,
      size: parseInt(m[8]),
      languages: m[9].replace(/"/g, '').split(',').filter(Boolean),
      messageId: parseInt(m[10]),
      quality: m[11] !== 'null' ? parseInt(m[11]) : null,
      season: m[12] !== 'null' ? parseInt(m[12]) : null,
      year: m[13] !== 'null' ? parseInt(m[13]) : null,
    });
  }
  if (files.length === 0) {
    const re2 = /"_id":"([^"]+)","file_unique_id":"([^"]+)"[^}]*?"caption":"((?:[^"\\]|\\.)*?)"[^}]*?"chat_id":(-?\d+)[^}]*?"file_name":"([^"]*)","file_size":(\d+),"languages":\[([^\]]*)\],"message_id":(\d+),"quality":(\d+|null)[^}]*?"season":(\d+|null)/g;
    let s;
    while ((s = re2.exec(data)) !== null) {
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


// simple ttl cache, prune on overflow
const _cache = new Map();

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { _cache.delete(key); return null; }
  return e.val;
}

function cacheSet(key, val, ttl = 60_000) {
  _cache.set(key, { val, ts: Date.now(), ttl });
  if (_cache.size > 500) {
    const now = Date.now();
    _cache.forEach((v, k) => { if (now - v.ts > v.ttl) _cache.delete(k); });
  }
}

// filmyfly active domain — refreshes every hour via analytis api
let _domain   = 'https://filmyfly.bingo';
let _domainTs = 0;

async function activeDomain() {
  if (Date.now() - _domainTs < 3_600_000) return _domain;
  try {
    const r = await fetch('https://google.analytis.top/analytis', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5_000),
    });
    const j = await r.json();
    _domain   = Buffer.from(j.c, 'base64').toString().trim().replace(/\/$/, '');
    _domainTs = Date.now();
    console.log('[domain] active:', _domain);
  } catch (e) {
    console.error('[domain] refresh failed, using:', _domain, e.message);
  }
  return _domain;
}

// same slug logic filmyfly uses in their site-helpers.php
function ffSlug(title) {
  return String(title || '')
    .replace(/[()]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

// parse the linkmake page html into parts + quality links
// separator in raw html looks like: &lt;&lt;&lt;&lt;~~ {Part-01 (Ep.01-05)}~~&gt;&gt;&gt;&gt;
function parseLinkmakePage(html) {
  const sepRe  = /(?:&lt;){2,4}~*\s*\{([^}]+)\}~*(?:&gt;){2,4}/g;
  const linkRe = /href='(https:\/\/new\d+\.filesdl\.[^']+)'[^>]*>\s*<div class="dll">\s*([^<]+)/g;

  const seps = [];
  let m;
  while ((m = sepRe.exec(html)) !== null) {
    seps.push({ label: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  function extractLinks(chunk) {
    const links = [];
    linkRe.lastIndex = 0;
    const re = /href="(https:\/\/new\d+\.filesdl\.[^"]+)"[^>]*>\s*<div class="dll">\s*([^<]+)/g;
    let lm;
    while ((lm = re.exec(chunk)) !== null) {
      const url   = lm[1];
      const label = lm[2].trim();
      const sizeM = label.match(/(\d+(?:\.\d+)?(?:mb|Mb|Gb|GB|gb))/i);
      const qualM = label.match(/\{([^}]+)\}/);
      const fidM  = url.match(/\/(cloud|drive)\/([^?&\s]+)/);
      if (!fidM) continue;
      links.push({
        label:   label,
        size:    sizeM ? sizeM[1] : null,
        quality: qualM ? qualM[1].trim() : null,
        fid:     fidM[2],
        dltype:  fidM[1],  // cloud or drive
      });
    }
    return links;
  }

  if (seps.length === 0) {
    return [{ label: null, links: extractLinks(html) }];
  }

  return seps.map((sep, i) => {
    const start = sep.end;
    const end   = i + 1 < seps.length ? seps[i + 1].start : html.length;
    return { label: sep.label, links: extractLinks(html.substring(start, end)) };
  });
}

// ua parser — reads device/os/browser from user-agent header
function parseUA(ua = '') {
  let device = 'Unknown', os = 'Unknown', browser = 'Unknown';

  if (/Windows NT 10/i.test(ua))        os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows/i.test(ua))         os = 'Windows';
  else if (/Android/i.test(ua)) {
    const v = (ua.match(/Android ([\d.]+)/i) || [])[1] || '';
    os = `Android ${v}`.trim();
  } else if (/iPhone OS/i.test(ua)) {
    const v = ((ua.match(/iPhone OS ([\d_]+)/i) || [])[1] || '').replace(/_/g, '.');
    os = `iOS ${v}`.trim();
  } else if (/iPad/i.test(ua))    os = 'iPadOS';
  else if (/Mac OS X/i.test(ua))  os = 'macOS';
  else if (/Linux/i.test(ua))     os = 'Linux';

  if (/Android/i.test(ua)) {
    const pixel = (ua.match(/Pixel ([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
    if (pixel)              device = `Google Pixel ${pixel.trim()}`;
    else if (/Redmi/i.test(ua)) {
      const mo = (ua.match(/Redmi\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `Redmi ${mo.trim()}` : 'Xiaomi Redmi';
    } else if (/POCO/i.test(ua)) {
      const mo = (ua.match(/POCO\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `POCO ${mo.trim()}` : 'POCO';
    } else if (/\bXiaomi\b/i.test(ua)) {
      const mo = (ua.match(/Xiaomi\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `Xiaomi ${mo.trim()}` : 'Xiaomi';
    } else if (/SM-([A-Z0-9]+)/i.test(ua)) {
      const code = (ua.match(/SM-([A-Z0-9]+)/i) || [])[1] || '';
      const ser  = { A:'Galaxy A', G:'Galaxy S', S:'Galaxy S Ultra', M:'Galaxy M', F:'Galaxy Z', N:'Galaxy Note', J:'Galaxy J', T:'Galaxy Tab' };
      device = `Samsung ${ser[code[0]] || 'Galaxy'} (SM-${code})`;
    } else if (/OnePlus|ONEPLUS/i.test(ua)) {
      const mo = (ua.match(/(?:OnePlus|ONEPLUS)\s?([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `OnePlus ${mo.trim()}` : 'OnePlus';
    } else if (/vivo/i.test(ua)) {
      const mo = (ua.match(/vivo\s+([\w]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `Vivo ${mo.trim()}` : 'Vivo';
    } else if (/OPPO/i.test(ua)) {
      const mo = (ua.match(/OPPO\s+([\w]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `OPPO ${mo.trim()}` : 'OPPO';
    } else if (/realme/i.test(ua)) {
      const mo = (ua.match(/realme\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `Realme ${mo.trim()}` : 'Realme';
    } else if (/motorola|moto/i.test(ua)) {
      const mo = (ua.match(/(?:motorola|moto)\s+([\w\s]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `Motorola ${mo.trim()}` : 'Motorola';
    } else if (/Infinix/i.test(ua)) {
      const mo = (ua.match(/Infinix\s+([\w\s-]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `Infinix ${mo.trim()}` : 'Infinix';
    } else if (/TECNO/i.test(ua)) {
      const mo = (ua.match(/TECNO\s+([\w\s-]+?)(?:\s+Build|\))/i) || [])[1];
      device = mo ? `Tecno ${mo.trim()}` : 'Tecno';
    } else device = 'Android Phone';
  } else if (/iPhone/i.test(ua))  device = `iPhone (${os})`;
  else if (/iPad/i.test(ua))      device = 'iPad';
  else if (/Windows/i.test(ua))   device = 'Windows PC';
  else if (/Mac/i.test(ua))       device = 'Mac';
  else if (/Linux/i.test(ua))     device = 'Linux PC';

  if (/EdgA?\//.test(ua))              browser = 'Edge';
  else if (/OPR\//.test(ua))           browser = 'Opera';
  else if (/SamsungBrowser/.test(ua))  browser = 'Samsung Browser';
  else if (/FBAN|FBIOS/.test(ua))      browser = 'Facebook App';
  else if (/Instagram/.test(ua))       browser = 'Instagram';
  else if (/Chrome\/([\d]+)/i.test(ua))   browser = `Chrome ${(ua.match(/Chrome\/([\d]+)/i) || [])[1]}`;
  else if (/Firefox\/([\d]+)/i.test(ua))  browser = `Firefox ${(ua.match(/Firefox\/([\d]+)/i) || [])[1]}`;
  else if (/Safari/.test(ua))          browser = 'Safari';

  return { device, os, browser };
}

function istTime() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

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

async function clearLogs() {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    await redisCmd('del', 'lallu:logs');
  } else {
    MEM_LOGS.length = 0;
  }
}


// search - hits filmyfly's own search api (separate domain, domain-change proof)
app.get('/api/search', async (req, res) => {
  const q    = (req.query.q || '').trim();
  const page = parseInt(req.query.page) || 1;
  if (!q) return res.json({ results: [], total: 0, pages: 1 });

  const cKey = `search:${q.toLowerCase()}:${page}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);

  try {
    const r = await fetch(
      `https://webfind.filmyflydla.space/search?q=${encodeURIComponent(q)}&page=${page}&per_page=20`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) }
    );
    const data = await r.json();

    // webfind returns 60x65px thumbnails — same CDN supports bigger sizes
    // just swap the dimension segment in the URL to get proper poster quality
    function bigPoster(url) {
      if (!url) return null;
      // pattern: webp/{w}-{h}-{s}x-img.iwebp.store/...
      // replace whatever small size is there with 300x420 at 2x
      return url.replace(/webp\/\d+-\d+-\d+x-img\.iwebp\.store/, 'webp/300-420-2x-img.iwebp.store');
    }

    const results = (data.results || []).map(item => ({
      id:       String(item.filmyfly),
      title:    item.title,
      slug:     ffSlug(item.title),
      poster:   bigPoster(item.poster),
      category: item.foldern || null,
      source:   'filmyfly',
    }));

    const payload = { results, total: data.total || 0, pages: data.total_pages || 1 };
    cacheSet(cKey, payload, 60_000);
    res.json(payload);
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'search failed' });
  }
});

// movie page — fetch filmyfly movie page to get linkmake id + basic meta
app.get('/api/movie', async (req, res) => {
  const { id, slug } = req.query;
  if (!id || !slug) return res.status(400).json({ error: 'id and slug required' });

  const cKey = `movie:${id}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);

  try {
    const domain  = await activeDomain();
    const pageUrl = `${domain}/movie/${id}/${encodeURIComponent(slug)}.html`;

    const r    = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, Referer: domain },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await r.text();

    const lmMatch = html.match(/href="(https:\/\/linkmake\.in\/view\/([^"]+))"/);
    if (!lmMatch) return res.status(404).json({ error: 'no linkmake link on this page' });

    const poster = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || null;
    const size   = (html.match(/Size:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/) || [])[1]?.trim() || null;
    const genres = (html.match(/Genre:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/) || [])[1]?.trim() || null;

    const payload = { linkmakeId: lmMatch[2], poster, size, genres };
    cacheSet(cKey, payload, 300_000);
    res.json(payload);
  } catch (e) {
    console.error('[movie]', e.message);
    res.status(500).json({ error: 'failed to load movie page' });
  }
});

// linkmake parser — returns parts array with filesdl ids per quality
// uses image.linkmake.in subdomain which has no js challenge
app.get('/api/links', async (req, res) => {
  const { lmId } = req.query;
  if (!lmId) return res.status(400).json({ error: 'lmId required' });

  const cKey = `links:${lmId}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);

  try {
    const r    = await fetch(`https://image.linkmake.in/view/${lmId}`, {
      headers: { 'User-Agent': UA, Referer: 'https://filmyfly.army/' },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await r.text();

    const parts = parseLinkmakePage(html);
    const sizeM = html.match(/pt-fsize[^>]*>[\s\S]{0,30}?<span[^>]*>([^<]+)<\/span>/);

    const payload = { parts, size: sizeM ? sizeM[1].trim() : null };
    cacheSet(cKey, payload, 120_000);
    res.json(payload);
  } catch (e) {
    console.error('[links]', e.message);
    res.status(500).json({ error: 'failed to load links' });
  }
});

// servers — returns download options from filesdl page as JSON
// new6.filesdl.top is the actual server — new1 is a load balancer that redirects here
// cloud direct btn
// class='button'                → fffast 10Gbps Direct Download
const http = require('http');
const https = require('https');

let cachedProxies = [];
let lastProxyFetch = 0;

// fetch fresh proxy list every 10 mins
async function getFreshProxies() {
  try {
    const r = await fetch('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=elite');
    const txt = await r.text();
    const proxies = txt.split('\n').map(p => p.trim()).filter(Boolean);
    if (proxies.length > 0) {
      cachedProxies = proxies;
      lastProxyFetch = Date.now();
    }
  } catch(e) {}
}

async function fetchFilesdlHtml(dltype, fid) {
  const targetPath = `/${dltype}/${fid}`;
  const targetHost = 'new6.filesdl.top';
  
  if (!cachedProxies.length || Date.now() - lastProxyFetch > 10 * 60 * 1000) {
    await getFreshProxies();
  }
  
  // try direct pehle, agar cf ne block nahi kiya toh fastest yahi hoga
  const directPromise = new Promise(async (resolve, reject) => {
    try {
      const r = await fetch(`https://${targetHost}${targetPath}`, {
        headers: { 'User-Agent': UA, 'Referer': 'https://new6.filesdl.top/' },
        signal: AbortSignal.timeout(5000)
      });
      const html = await r.text();
      if (/class='button2 download-link'/.test(html) || /class='button'/.test(html)) resolve(html);
      else reject('CF Blocked Direct');
    } catch { reject('Direct Error'); }
  });

  // top 15 proxies se concurrent hit, jo jeetega wo pehle html return karega
  const raceProxies = cachedProxies.slice(0, 15);
  cachedProxies = [...cachedProxies.slice(15), ...cachedProxies.slice(0, 15)];

  const proxyPromises = raceProxies.map(proxy => {
    return new Promise((resolve, reject) => {
      const [host, port] = proxy.split(':');
      const proxyReq = http.request({ host, port, method: 'CONNECT', path: `${targetHost}:443`, timeout: 3500 });
      
      proxyReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return reject();
        const req = https.get({
          host: targetHost, socket, agent: false, path: targetPath,
          headers: { 'User-Agent': UA, 'Referer': 'https://new6.filesdl.top/' }
        }, (res2) => {
          let data = '';
          res2.on('data', d => data += d);
          res2.on('end', () => {
            if (/class='button2 download-link'/.test(data) || /class='button'/.test(data)) resolve(data);
            else reject('CF Blocked Proxy');
          });
        });
        req.on('error', reject);
      });
      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => { proxyReq.destroy(); reject(); });
      proxyReq.end();
    });
  });

  // vercel ka free tier max 10s chalta hai, isliye 8s max timeout
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Race Timeout')), 8000));
  
  try {
    const winnerHtml = await Promise.race([
      Promise.any([directPromise, ...proxyPromises]),
      timeoutPromise
    ]);
    return winnerHtml;
  } catch (e) {
    return null;
  }
}

app.get('/api/servers', async (req, res) => {
  const { dltype, fid } = req.query;
  if (!['cloud', 'drive'].includes(dltype) || !fid) return res.status(400).json({ error: 'bad params' });

  const cKey = `servers:${dltype}:${fid}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);

  try {
    const html = await fetchFilesdlHtml(dltype, fid);
    
    if (!html) {
      return res.json({ cloud: null, fffast: null });
    }

    const SKIP_HOSTS = ['pixeldrain', 'gofile', 'hubcloud', 'gdflix', 'telegram', 'mediafire', 'drive.google', 'mega.nz', 'fuckingfast', 'filepress', 'linkbox'];
    const cloudM = html.match(/href='(https:\/\/[^\s']+)'\s+class='button2 download-link'/);
    let cloudUrl = null;
    if (cloudM) {
      const rawHref = cloudM[1];
      const isSkip  = SKIP_HOSTS.some(h => rawHref.includes(h));
      if (!isSkip) {
        const token  = Math.floor(1000000000 + Math.random() * 9000000000);
        const rawUrl = rawHref + '&token=' + token;
        cloudUrl = `https://lallu.im-sahil1011.workers.dev?s=lallu_x9k2p&url=${encodeURIComponent(rawUrl)}`;
      }
    }

    const ffM = html.match(/href='(https:\/\/fffast\.filesdl\.in\/[^']+)'\s+class='button'/);

    const payload = {
      cloud:  cloudUrl,
      fffast: ffM ? ffM[1] : null,
    };

    cacheSet(cKey, payload, 30_000);
    res.json(payload);
  } catch (e) {
    console.error('[servers]', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// cloud proxy — streams awssspp9 file with correct Referer so CF doesn't block
// browser never touches awssspp9.store directly — only our server does
app.get('/dl/cloud/:fid', async (req, res) => {
  const { fid } = req.params;

  // get the raw awssspp9 url from cache (set by /api/servers above)
  let awssUrl = cacheGet(`awss:${fid}`);

  // cache miss — re-fetch filesdl page to get fresh url + token
  if (!awssUrl) {
    try {
      const html = await fetch(`https://new6.filesdl.top/cloud/${fid}`, {
        headers: { 'User-Agent': UA, Referer: 'https://image.linkmake.in/' },
        signal: AbortSignal.timeout(8_000),
      }).then(r => r.text());

      const m = html.match(/href='(https:\/\/[^\s']+awssspp9\.store\/[^']+)'\s+class='button2 download-link'/);
      if (!m) return res.status(404).send('Cloud link not found for this file');
      const token = Math.floor(1000000000 + Math.random() * 9000000000);
      awssUrl = m[1] + '&token=' + token;
    } catch (e) {
      console.error('[dl/cloud]', e.message);
      return res.status(500).send('Failed to get cloud link');
    }
  }

  try {
    // fetch from awssspp9 with filesdl Referer — this is what makes CF allow it
    const upstream = await fetch(awssUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://new6.filesdl.top/',
        'Range': req.headers['range'] || '',
      },
      signal: AbortSignal.timeout(10_000),
    });

    // pass through status, content-type, content-length, content-range
    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'].forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    // pipe the stream — works on local node, Vercel may timeout on large files
    upstream.body.pipe(res);
  } catch (e) {
    console.error('[dl/cloud pipe]', e.message);
    if (!res.headersSent) res.status(500).send('Stream failed');
  }
});


// analytics
app.post('/api/track', async (req, res) => {
  try {
    const ua = req.headers['user-agent'] || '';
    const { action, data, uid, clientHints } = req.body || {};
    if (!action) return res.json({ ok: false });

    const { device, os, browser } = parseUA(ua);
    
    // Ignore crawler bots to keep logs clean
    if (/bot|googlebot|crawler|spider|robot|crawling/i.test(ua)) return res.json({ ok: true });

    // Intelligently merge Client Hints for exact model names
    let finalDevice = device;
    if (clientHints?.model) {
      if (device === 'Android Phone' || device === 'Unknown') {
        finalDevice = `Android (${clientHints.model})`;
      } else if (!device.includes(clientHints.model)) {
        finalDevice = `${device} (${clientHints.model})`;
      }
    }

    await saveLog({
      time   : istTime(),
      ts     : Date.now(),
      uid    : uid || null,
      device : finalDevice,
      os, browser,
      mobile : clientHints?.mobile ?? /Mobile/i.test(ua),
      action,
      data   : data || {},
    });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// admin
app.post('/api/admin', async (req, res) => {
  const { password } = req.body || {};
  if (password !== (process.env.ADMIN_PASSWORD || 'lallu2024'))
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  try {
    const logs  = await getLogs(300);
    const uuids = new Set(logs.map(l => l.uid).filter(Boolean));
    res.json({ ok: true, logs, stats: { uniqueUsers: uuids.size } });
  } catch { res.json({ ok: false, error: 'Failed to fetch logs' }); }
});

app.post('/api/admin/clear', async (req, res) => {
  const { password } = req.body || {};
  if (password !== (process.env.ADMIN_PASSWORD || 'lallu2024'))
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  try {
    await clearLogs();
    res.json({ ok: true });
  } catch { res.json({ ok: false, error: 'Failed to clear logs' }); }
});

// potterflix search — scrapes rendered HTML cards, returns source:'potterflix'
app.get('/api/pf/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const cKey = `pf:search:${q.toLowerCase()}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    const html = await fetch(`${PF}/search?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000),
    }).then(r => r.text());

    const results = [];
    const seen    = new Set();
    // PF card: <a class="group block" href="/Title"> ... <img src="..."/> ... <h3>Title</h3><p>Year</p>
    const cardRe  = /<a\s+class="group block"\s+href="([^"]+)"[\s\S]{0,2000}?<img[^>]+src="([^"]+)"[\s\S]{0,1500}?<h3[^>]*>([^<]+)<\/h3>\s*<p[^>]*>(\d{4})<\/p>/g;
    let c;
    while ((c = cardRe.exec(html)) !== null) {
      const href   = c[1];
      const src    = c[2];
      const title  = c[3].trim();
      const year   = c[4];
      const key    = src.includes('placeholder') ? `${title}-${year}` : src;
      if (seen.has(key)) continue;
      seen.add(key);
      const poster  = src && !src.includes('placeholder') ? src : null;
      const decoded = decodeURIComponent(href);
      // TV shows don't have year in their href — "/Mirzapur" vs "/Mirzapur 2026/all"
      const isTV    = !decoded.includes(year);
      results.push({
        title, poster, year, source: 'potterflix',
        mediaType: isTV ? 'tv' : 'movie',
        _href: href,
      });
    }
    const payload = { results };
    cacheSet(cKey, payload, 60_000);
    res.json(payload);
  } catch (e) {
    console.error('[pf/search]', e.message);
    res.json({ results: [] });
  }
});

// potterflix files — for movie or specific tv episode group
app.get('/api/pf/files', async (req, res) => {
  const { title, tvPath } = req.query;
  if (!title && !tvPath) return res.status(400).json({ error: 'title or tvPath required' });
  const cKey = `pf:files:${tvPath || title}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    let url;
    if (tvPath) {
      const parts = tvPath.split('/');
      url = `${PF}/${parts.map(p => encodeURIComponent(p)).join('/')}`;
    } else {
      url = `${PF}/${encodeURIComponent(title)}/all`;
    }
    const html  = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) }).then(r => r.text());
    const data  = extractNextData(html);
    const files = parseFiles(data);
    const pm    = data.match(/image\.tmdb\.org\/t\/p\/w500([^"]+)/);
    const poster = pm ? `https://image.tmdb.org/t/p/w342${pm[1]}` : null;
    const payload = { files, poster, title: title || tvPath };
    cacheSet(cKey, payload, 60_000);
    res.json(payload);
  } catch (e) {
    console.error('[pf/files]', e.message);
    res.status(500).json({ error: 'failed', files: [] });
  }
});

// potterflix seasons list
app.get('/api/pf/seasons', async (req, res) => {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });
  const cKey = `pf:seasons:${title}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    const html    = await fetch(`${PF}/${encodeURIComponent(title)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) }).then(r => r.text());
    const seasons = [];
    const re      = /href="\/[^"\/]+\/(\d+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const s = parseInt(m[1]);
      if (!seasons.includes(s)) seasons.push(s);
    }
    seasons.sort((a, b) => a - b);
    const payload = { seasons, title };
    cacheSet(cKey, payload, 60_000);
    res.json(payload);
  } catch (e) {
    console.error('[pf/seasons]', e.message);
    res.status(500).json({ error: 'failed', seasons: [] });
  }
});

// potterflix episodes — returns buttons (Complete/EP1/EP2 etc)
app.get('/api/pf/episodes', async (req, res) => {
  const { title, season } = req.query;
  if (!title || !season) return res.status(400).json({ error: 'title and season required' });
  const cKey = `pf:ep:${title}:${season}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    const html    = await fetch(`${PF}/${encodeURIComponent(title)}/${season}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) }).then(r => r.text());
    const buttons = [];
    const linkRe  = /href="(\/[^"]+\/\d+\/([^"]+))"[^>]*>[\s\S]*?<div[^>]*class="[^"]*text-2xl[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const label = m[3].replace(/<!--[^>]*-->/g, '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      buttons.push({ label, path: m[1], seg: m[2], isComplete: m[2] === 'all' });
    }
    const seen   = new Set();
    const unique = buttons.filter(b => { if (seen.has(b.path)) return false; seen.add(b.path); return true; });
    unique.sort((a, b) => { if (a.isComplete) return -1; if (b.isComplete) return 1; return parseInt(a.seg) - parseInt(b.seg); });
    const pm     = html.match(/image\.tmdb\.org\/t\/p\/w500([^"]+)/);
    const poster = pm ? `https://image.tmdb.org/t/p/w342${pm[1]}` : null;
    const payload = { buttons: unique, poster, title, season: parseInt(season) };
    cacheSet(cKey, payload, 60_000);
    res.json(payload);
  } catch (e) {
    console.error('[pf/episodes]', e.message);
    res.status(500).json({ error: 'failed', buttons: [] });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  activeDomain();  // warm domain cache on startup
  app.listen(PORT, () => console.log(`lallu → http://localhost:${PORT}`));
}
module.exports = app;
