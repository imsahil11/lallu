const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true }));

// log any API call slower than 3s (path only, no query string) so "why was it slow" has an answer in the logs
app.use('/api', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (ms > 3000) console.warn(`[slow] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms}ms`);
  });
  next();
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PF = (process.env.POTTERFLIX_URL || 'https://potterflixmovies.vercel.app').replace(/\/$/, '');

// potterflix — extract RSC streamed json chunks from rendered page
function extractNextData(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,"(.+?)"\]\)/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { parts.push(JSON.parse(`"${m[1]}"`)); } catch (e) { console.warn('[pf] rsc chunk parse fail:', e.message?.slice(0, 60)); }
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


// hosts remembered from parsed pages (linkmake id -> linkmake host, filesdl file id -> filesdl host).
// only a hint: defaults below kick in on a cold serverless instance or an unknown id.
const DEFAULT_LM_HOST  = 'linkmake.in';
const DEFAULT_FD_HOST  = 'new1.filesdl.in';
const FD_WORKER        = process.env.WORKER_URL    || 'https://lallu.im-sahil1011.workers.dev';
// set WORKER_SECRET in Vercel env (same value as in the worker) — the fallback only keeps old setups working
const WORKER_SECRET    = process.env.WORKER_SECRET || 'lallu_x9k2p';
const LM_HOSTS = new Map();
const FD_HOSTS = new Map();
const FD_RESOLVED = new Map();   // "host/type" -> { host, path, ts } after following load-balancer redirects

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

// filmyfly active domain — nothing hardcoded as the single source of truth.
// candidates (in order): analytis api -> last known good -> env list.
// every candidate is verified (/rss.xml must return real rss) before it is used,
// so a dead/parked domain is never picked. callers can force a re-resolve on failure.
const FF_ANALYTICS = process.env.DOMAIN_API || 'https://google.analytis.top/analytis';
const FF_FALLBACKS = (process.env.FILMYFLY_DOMAINS || '')   // optional extra candidates, empty by default
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

let _domain   = null;   // last verified domain
let _domainTs = 0;
let _domainP  = null;   // in-flight refresh, shared by concurrent callers

async function probeDomain(d) {
  try {
    const r = await fetch(`${d}/rss.xml`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4_000) });
    if (!r.ok) return false;
    return /<rss/i.test((await r.text()).slice(0, 500));
  } catch { return false; }
}

async function analyticsDomain() {
  try {
    const r = await fetch(FF_ANALYTICS, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4_000) });
    const j = await r.json();
    const d = Buffer.from(j.c, 'base64').toString().trim().replace(/\/$/, '');
    return /^https?:\/\//.test(d) ? d : null;
  } catch (e) {
    console.error('[domain] analytis api failed:', e.message);
    return null;
  }
}

async function resolveDomain() {
  const cands = [...new Set([await analyticsDomain(), _domain, ...FF_FALLBACKS].filter(Boolean))];
  for (const d of cands) {
    if (await probeDomain(d)) {
      if (d !== _domain) console.log('[domain] active:', d);
      _domain = d; _domainTs = Date.now();
      return d;
    }
    console.warn('[domain] dead, skipping:', d);
  }
  // nothing verified — keep whatever we had so requests still get a chance
  _domainTs = Date.now() - 3_000_000;  // retry again in ~10 min
  if (_domain || cands[0]) return _domain || cands[0];
  throw new Error('no filmyfly domain available (analytis api down and nothing cached)');
}

async function activeDomain(force = false) {
  if (!force && _domain && Date.now() - _domainTs < 3_600_000) return _domain;
  if (!_domainP) _domainP = resolveDomain().finally(() => { _domainP = null; });
  return _domainP;
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
// part separators come in many decorated forms, e.g.
//   &lt;&lt;&lt;&lt;~~ {Part-01 (Ep.01-05)}~~&gt;&gt;&gt;&gt;
//   &lt;&lt;==××-- { Ep.01-05 } --××==&gt;&gt;
//   &lt;&lt;&lt;=××-- {Part-01 Ep.01-10} --××=&gt;&gt;&gt;
//   &lt;&lt;=×××--- Ep.01-08 ---×××=&gt;&gt;          (no braces at all)
// so: anything wrapped in 2+ "<" ... 2+ ">" counts, and the decoration is stripped off the label.
function parseLinkmakePage(html) {
  const sepRe = /(?:&lt;|<){2,}((?:(?!&lt;|&gt;|<|>)[^\n]){2,120}?)(?:&gt;|>){2,}/g;

  const seps = [];
  let m;
  while ((m = sepRe.exec(html)) !== null) {
    const label = m[1].replace(/^[\s~=×*_\-–—{]+|[\s~=×*_\-–—}]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!label || !/[A-Za-z0-9]/.test(label)) continue;
    seps.push({ label, start: m.index, end: m.index + m[0].length });
  }

  function extractLinks(chunk) {
    const links = [];
    // host-agnostic + markup-agnostic: any <a href=".../(cloud|drive)/ID">...label...</a>
    // (filesdl has moved between new1/new6/new8 and .in/.top; the inner <div class="dll"> wrapper is optional)
    const re = /<a\b[^>]*?href=["'](https:\/\/([^\/"']+)\/(?:cloud|drive)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
    let lm;
    while ((lm = re.exec(chunk)) !== null) {
      const url   = lm[1].replace(/&amp;/g, '&');
      const host  = lm[2];
      const label = lm[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!label) continue;
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
        host,
      });
    }
    return links;
  }

  if (seps.length === 0) {
    return [{ label: null, links: extractLinks(html) }];
  }

  const parts = seps.map((sep, i) => {
    const start = sep.end;
    const end   = i + 1 < seps.length ? seps[i + 1].start : html.length;
    return { label: sep.label, links: extractLinks(html.substring(start, end)) };
  });

  // links that sit before the first separator would otherwise be lost
  const pre = extractLinks(html.substring(0, seps[0].start));
  if (pre.length) parts.unshift({ label: 'Main', links: pre });

  // footer-style separators ("...The End...") own no links — drop empty parts (keep all if nothing parsed)
  const nonEmpty = parts.filter(p => p.links.length);
  return nonEmpty.length ? nonEmpty : parts;
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
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_500) }   // never let redis hang a request
    );
    return (await r.json()).result;
  } catch { return null; }
}

// several redis commands in ONE http round trip (upstash /pipeline)
async function redisPipeline(cmds) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(2_500),
    });
    return await r.json();
  } catch { return null; }
}

async function saveLog(entry) {
  const str = JSON.stringify(entry);
  if (process.env.UPSTASH_REDIS_REST_URL) {
    await redisPipeline([['LPUSH', 'lallu:logs', str], ['LTRIM', 'lallu:logs', '0', '999']]);
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

async function loadWarmProxiesFromRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    const raw = await redisCmd('get', 'lallu:warm-proxies');
    if (!raw) return;
    const data = JSON.parse(raw);
    const cutoff = Date.now() - 30 * 60_000;
    data.forEach(([proxy, ts]) => { if (ts > cutoff) WARM_PROXIES.set(proxy, ts); });
    if (WARM_PROXIES.size) console.log(`[warm] loaded ${WARM_PROXIES.size} warm proxies from redis`);
  } catch {}
}

function persistWarmProxies() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !WARM_PROXIES.size) return;
  const data = JSON.stringify([...WARM_PROXIES.entries()]);
  redisCmd('setex', 'lallu:warm-proxies', '1800', data).catch(() => {});
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

    // filmyfly marks titles whose download links were removed by giving them the shared "404.png" poster;
    // those only ever lead to "Link nahi mila", so don't show them at all
    const isBroken = item => /\/404\.(png|webp|jpe?g)(\?|$)/i.test(item.poster || '');

    const results = (data.results || []).filter(item => !isBroken(item)).map(item => ({
      id:       String(item.filmyfly),
      title:    item.title,
      slug:     ffSlug(item.title),
      poster:   bigPoster(item.poster),
      category: item.foldern || null,
      source:   'filmyfly',
    }));

    const payload = { results, total: data.total || 0, pages: data.total_pages || 1 };
    cacheSet(cKey, payload, 300_000);
    res.json(payload);
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'search failed' });
  }
});

// movie page — fetch filmyfly movie page to get linkmake id + basic meta
const httpErr = (status, message) => Object.assign(new Error(message), { status });

async function loadMovie(id) {
  const cKey = `movie:${id}`;
  const hit  = cacheGet(cKey);
  if (hit) return hit;

  {
    // filmyfly ignores the slug segment (any "/movie/<id>/x.html" resolves), so we never
    // depend on our own slug logic. if the domain looks dead, re-resolve once and retry.
    const loadPage = async (domain) => {
      const r = await fetch(`${domain}/movie/${encodeURIComponent(id)}/x.html`, {
        headers: { 'User-Agent': UA, Referer: domain + '/' },
        signal: AbortSignal.timeout(10_000),
      });
      return r.ok ? r.text() : null;
    };
    // prefer the main download button (a.bg2), fall back to any /view/ link on the page
    const LM_RE = {
      exec: (h) => h.match(/class=["']bg2["'][^>]*href=["'](https:\/\/([^\/"']+)\/view\/([^"'?#]+))["']/)
                || h.match(/href=["'](https:\/\/([^\/"']+)\/view\/([^"'?#]+))["'][^>]*class=["']bg2["']/)
                || h.match(/href=["'](https:\/\/([^\/"']+)\/view\/([^"'?#]+))["']/),
    };

    let html = null, lmMatch = null;
    try { html = await loadPage(await activeDomain()); lmMatch = html && LM_RE.exec(html); } catch { /* retry below */ }
    if (!lmMatch) {
      const fresh = await activeDomain(true);
      html = await loadPage(fresh);
      lmMatch = html && LM_RE.exec(html);
    }
    if (!lmMatch) throw httpErr(404, 'no linkmake link on this page');
    LM_HOSTS.set(lmMatch[3], lmMatch[2]);

    const poster = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || null;
    const size   = (html.match(/Size:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/) || [])[1]?.trim() || null;
    const genres = (html.match(/Genre:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/) || [])[1]?.trim() || null;

    const payload = { linkmakeId: lmMatch[3], poster, size, genres };
    cacheSet(cKey, payload, 300_000);
    return payload;
  }
}

app.get('/api/movie', async (req, res) => {
  const { id } = req.query;   // slug is accepted but unused
  if (!id || !/^\d+$/.test(id)) return res.status(400).json({ error: 'numeric id required' });
  try {
    res.json(await loadMovie(id));
  } catch (e) {
    console.error('[movie]', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'failed to load movie page' });
  }
});

// linkmake parser — returns parts array with filesdl ids per quality
// uses image.linkmake.in subdomain which has no js challenge
async function loadLinks(lmId) {
  const cKey = `links:${lmId}`;
  const hit  = cacheGet(cKey);
  if (hit) return hit;

  {
    // host comes from the movie page (remembered in LM_HOSTS); "image." subdomain skips the js
    // challenge when it exists, otherwise plain host. both tried, first with real links wins.
    const lmHost = LM_HOSTS.get(lmId) || DEFAULT_LM_HOST;
    const hosts  = [...new Set([`image.${lmHost.replace(/^image\./, '')}`, lmHost, DEFAULT_LM_HOST])];
    const domain = await activeDomain().catch(() => 'https://filmyfly.info');   // only used as a Referer
    let parts = null, html = '';
    for (const h of hosts) {
      try {
        const r = await fetch(`https://${h}/view/${encodeURIComponent(lmId)}`, {
          headers: { 'User-Agent': UA, Referer: domain + '/' },
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) continue;
        html = await r.text();
        const p = parseLinkmakePage(html);
        if (p.some(x => x.links.length)) { parts = p; break; }
      } catch { /* try next host */ }
    }
    if (!parts) throw httpErr(502, 'no links found on linkmake page');

    // remember each link's own host so /api/servers goes where the page said, not to a fixed server
    parts.forEach(p => p.links.forEach(l => FD_HOSTS.set(l.fid, l.host)));

    // by default all qualities are returned and the frontend reveals "drive" ones only if their links
    // can actually be fetched. HIDE_DRIVE=1 drops them server-side instead (when a part has cloud ones).
    if (process.env.HIDE_DRIVE === '1') {
      parts = parts.map(p => {
        const cloudOnly = p.links.filter(l => l.dltype !== 'drive');
        return cloudOnly.length ? { ...p, links: cloudOnly } : p;
      });
    }
    const sizeM = html.match(/pt-fsize[^>]*>[\s\S]{0,30}?<span[^>]*>([^<]+)<\/span>/);

    const payload = { parts, size: sizeM ? sizeM[1].trim() : null };
    cacheSet(cKey, payload, 300_000);
    return payload;
  }
}

app.get('/api/links', async (req, res) => {
  const { lmId } = req.query;
  if (!lmId) return res.status(400).json({ error: 'lmId required' });
  try {
    res.json(await loadLinks(lmId));
  } catch (e) {
    console.error('[links]', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'failed to load links' });
  }
});

// movie page + linkmake links in ONE round trip (frontend used to call /api/movie then /api/links)
app.get('/api/movie-links', async (req, res) => {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) return res.status(400).json({ error: 'numeric id required' });
  try {
    const movie = await loadMovie(id);
    const links = await loadLinks(movie.linkmakeId);
    res.json({ movie, links });
  } catch (e) {
    console.error('[movie-links]', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'failed to load movie', stage: e.status ? undefined : 'upstream' });
  }
});

// servers — returns download options from filesdl page as JSON
// new6.filesdl.top is the actual server — new1 is a load balancer that redirects here
// class='button' → fffast 10Gbps Direct Download

let cachedProxies = [];
let lastProxyFetch = 0;
let _proxyRefresh = null;                 // in-flight refresh, shared by concurrent requests
const WARM_PROXIES = new Map();           // "ip:port" -> last time it actually delivered a page

// proxy sources, newest/biggest first (v4 gives ~800 proxies, the old v2 only ~60)
const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=5000&ssl=true&anonymity=elite',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=elite',
];

// refresh the proxy list. 4s cap per source so a slow proxy site can never hang a request.
function getFreshProxies() {
  if (_proxyRefresh) return _proxyRefresh;
  _proxyRefresh = (async () => {
    for (const src of PROXY_SOURCES) {
      try {
        const r   = await fetch(src, { signal: AbortSignal.timeout(4_000) });
        const txt = await r.text();
        const proxies = txt.split('\n').map(p => p.trim()).filter(p => /^[\d.]+:\d+$/.test(p));
        if (proxies.length > 0) {
          cachedProxies = proxies;
          lastProxyFetch = Date.now();
          redisCmd('setex', 'lallu:proxies', '600', JSON.stringify(proxies)).catch(() => {});
          return;
        }
      } catch (e) { console.error('[proxies] fetch failed:', e.message); }
    }
  })().finally(() => { _proxyRefresh = null; });
  return _proxyRefresh;
}

// never block a user request on a stale list: empty -> Redis check -> proxyscrape (max 3s), stale -> refresh bg
async function ensureProxies() {
  const age = Date.now() - lastProxyFetch;
  if (!cachedProxies.length) {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      try {
        const raw = await redisCmd('get', 'lallu:proxies');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length > 0) {
            cachedProxies = list;
            lastProxyFetch = Date.now();
            getFreshProxies();  // background refresh
            return;
          }
        }
      } catch {}
    }
    await Promise.race([getFreshProxies(), new Promise(r => setTimeout(r, 3_000))]);
  } else if (age > 10 * 60_000) {
    getFreshProxies();   // fire and forget
  }
}

// proxies to try this round: recent winners first, then random others (shuffled so we don't hammer the same ones)
function pickProxies(n = 15) {
  const warm = [...WARM_PROXIES.entries()]
    .filter(([, t]) => Date.now() - t < 30 * 60_000)
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p);
  const rest = cachedProxies.filter(p => !warm.includes(p));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...warm, ...rest].slice(0, n);
}

// every download <a> on a filesdl page: { href, cls: [classes], text }. attribute order and quote style don't matter.
function filesdlAnchors(html) {
  const out = [];
  const re  = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const hm    = attrs.match(/\bhref\s*=\s*(?:'([^']*)'|"([^"]*)")/i);
    const cm    = attrs.match(/\bclass\s*=\s*(?:'([^']*)'|"([^"]*)")/i);
    const href  = hm ? (hm[1] ?? hm[2]) : null;
    const cls   = (cm ? (cm[1] ?? cm[2]) : '').split(/\s+/).filter(Boolean);
    if (!href || !/^https:\/\//i.test(href)) continue;
    out.push({ href: href.replace(/&amp;/g, '&'), cls, text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// a real filesdl page has styled download buttons (class="button", "button1", "download-link"...);
// a cloudflare challenge/blocked page has none.
function looksLikeFilesdlPage(html) {
  return /class\s*=\s*['"][^'"]*\b(button\d*|download-link)\b/i.test(html);
}

// Only two servers matter: "fffast" (10Gbps direct) and "cloud direct". Everything else is ignored.
//  fffast: the anchor whose class is exactly "button"; fallback = any link on a fffast.* host
//  cloud : the anchor with class "download-link"; fallback = link on a known cloud-CDN host (CLOUD_HOSTS env, regex)
const CLOUD_HOSTS = new RegExp(process.env.CLOUD_HOSTS || '(^|\\.)(r2\\.dev|awssspp\\d*\\.store)$', 'i');
const NOT_CLOUD   = /pixeldrain|gofile|hubcloud|gdflix|telegram|t\.me|mediafire|drive\.google|mega\.nz|fuckingfast|filepress|linkbox|drivenext|workers\.dev/i;

function parseServersHtml(html) {
  const all = filesdlAnchors(html);
  const btn = all.filter(a => a.cls.some(c => /^button\d*$|^download-link$/.test(c)));
  const host = a => { try { return new URL(a.href).hostname; } catch { return ''; } };

  const ff = btn.find(a => a.cls.length === 1 && a.cls[0] === 'button')
          || all.find(a => /^fffast\./i.test(host(a)));

  const cloud = all.find(a => a.cls.includes('download-link') && !NOT_CLOUD.test(a.href))
             || all.find(a => CLOUD_HOSTS.test(host(a)));

  return { fffast: ff ? ff.href : null, cloud: cloud ? cloud.href : null, anchors: btn.length };
}

// filesdl sits behind a load balancer (new1 -> new6, drive -> new8 ...). proxies tunnel with CONNECT
// and can't follow redirects, so we learn where a link really lives with one cheap manual-redirect hop.
// result is cached per host+type; on any failure we fall back to the host the page gave us.
const FD_HOST_OK = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.filesdl\.[a-z]{2,}$/i;

// NginxAuth AES-CBC challenge solver for new8.filesdl.top /drive/ pages.
// The 202 response contains a small inline <script> that:
//   var a = toNumbers("hex...")   ← AES key
//   var b = toNumbers("hex...")   ← IV
//   var c = toNumbers("hex...")   ← ciphertext
//   document.cookie = "NAME=" + toHex(slowAES.decrypt(c, 2, a, b)) + "; path=/"
//   location.href = "http://host/drive/FID?d=1"
// We replicate the AES-CBC decrypt in Node's built-in crypto and return the cookie string.
function parseDriveChallenge(html) {
  // grab the three hex strings in order: a (key), b (iv), c (ciphertext)
  const nums = [...html.matchAll(/toNumbers\("([0-9a-fA-F]+)"\)/gi)].map(m => Buffer.from(m[1], 'hex'));
  // cookie name e.g. "vDDoS-0a"
  const nameM = html.match(/document\.cookie\s*=\s*["']([^=]+)=/);
  // redirect path after solving e.g. "/drive/FID?d=1"
  const hrefM = html.match(/location\.href\s*=\s*["']https?:\/\/[^/]+([^"']+)["']/);
  if (nums.length < 3 || !nameM) return null;
  try {
    const [key, iv, ciphertext] = nums;   // a, b, c
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // toHex() — lowercase hex of each byte
    const hexVal = dec.toString('hex');
    return { cookie: `${nameM[1]}=${hexVal}`, nextPath: hrefM ? hrefM[1] : null };
  } catch { return null; }
}

async function resolveFilesdlTarget(host, dltype, fid) {
  const key = `${host}/${dltype}`;
  const c   = FD_RESOLVED.get(key);
  if (c && Date.now() - c.ts < 10 * 60_000) return { host: c.host, path: `/${dltype}/${fid}` };

  // Redis check — cold start pe FD_RESOLVED khali hoti hai
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const rhost = await redisCmd('get', `lallu:fd:${host}:${dltype}`).catch(() => null);
    if (rhost && typeof rhost === 'string') {
      FD_RESOLVED.set(key, { host: rhost, ts: Date.now() });
      return { host: rhost, path: `/${dltype}/${fid}` };
    }
  }

  let cur = host;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(`https://${cur}/${dltype}/${fid}`, {
        redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(2000),
      });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (loc) {
        const u = new URL(loc, `https://${cur}`);
        if (!FD_HOST_OK.test(u.hostname)) break;
        cur = u.hostname;
        continue;
      }
      break;
    }
    FD_RESOLVED.set(key, { host: cur, ts: Date.now() });
    redisCmd('setex', `lallu:fd:${host}:${dltype}`, '600', cur).catch(() => {});
  } catch { /* use last resolved host */ }
  return { host: cur, path: `/${dltype}/${fid}` };
}

async function fetchFilesdlHtml(dltype, fid, linkHost) {
  const startHost   = FD_HOST_OK.test(linkHost || '') ? linkHost : DEFAULT_FD_HOST;
  const targetPath  = `/${dltype}/${fid}`;

  await ensureProxies();   // never blocks on a stale list (refreshes in background)

  // --- Layer 1: Direct fetch (with AES challenge solver for /drive/ pages) ---
  const directHosts = [startHost];

  const directPromises = directHosts.map(h => new Promise(async (resolve, reject) => {
    try {
      const r = await fetch(`https://${h}${targetPath}`, {
        headers: { 'User-Agent': UA, 'Referer': 'https://linkmake.in/' },
        signal: AbortSignal.timeout(5000)
      });
      let html = await r.text();

      // 202 = NginxAuth AES challenge (drive pages on new8). solve it inline.
      if (r.status === 202 && html.includes('slowAES')) {
        const solved = parseDriveChallenge(html);
        if (solved) {
          // use the final redirected host (e.g. new8.filesdl.top) so the Cookie header isn't lost on redirect
          let finalHost = h;
          try {
            const u = new URL(r.url);
            if (FD_HOST_OK.test(u.hostname)) finalHost = u.hostname;
          } catch {}
          console.log(`[filesdl] drive challenge detected on ${finalHost}, solving...`);
          const retryPath = solved.nextPath || targetPath;
          const r2 = await fetch(`https://${finalHost}${retryPath}`, {
            headers: { 'User-Agent': UA, 'Referer': r.url || 'https://linkmake.in/', 'Cookie': solved.cookie },
            signal: AbortSignal.timeout(6000),
          });
          html = await r2.text();
          if (looksLikeFilesdlPage(html)) { console.log(`[filesdl] drive challenge solved: ${finalHost}`); resolve(html); return; }
        }
        reject(`challenge unsolved: ${h}`); return;
      }

      if (looksLikeFilesdlPage(html)) { console.log(`[filesdl] direct ok: ${h}`); resolve(html); }
      else reject(`CF blocked: ${h}`);
    } catch { reject(`direct error: ${h}`); }
  }));

  // --- Layer 2: CF Worker (same CF network = no challenge) ---
  const workerPromise = new Promise(async (resolve, reject) => {
    try {
      const targetUrl = `https://${startHost}${targetPath}`;
      const r = await fetch(
        `${FD_WORKER}?url=${encodeURIComponent(targetUrl)}&mode=html`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) }
      );
      if (!r.ok) return reject('worker: not ok');
      const html = await r.text();
      if (looksLikeFilesdlPage(html)) { console.log('[filesdl] worker ok'); return resolve(html); }
      reject('worker: blocked');
    } catch (e) { reject('worker: ' + e.message); }
  });

  // --- Layer 3: Free proxy race (CONNECT tunnel, 10 proxies: recent winners first, rest shuffled) ---
  // proxies only start after direct has had a ~0.8s head start (or has already failed), so in the normal
  // case no proxy sockets are opened at all. when anyone wins, every other socket is closed right away.
  let finished = false;
  const sockets = new Set(), proxyReqs = new Set();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const headStart = Promise.race([sleep(800), Promise.any(directPromises).catch(() => {})]);
  const targetP = resolveFilesdlTarget(startHost, dltype, fid);

  function proxyFetch(proxy, targetHost, reqPath, cookie) {
    return new Promise((resolve, reject) => {
      if (finished) return reject();
      const [host, port] = proxy.split(':');
      const proxyReq = http.request({ host, port, method: 'CONNECT', path: `${targetHost}:443`, timeout: 3500 });
      proxyReqs.add(proxyReq);
      proxyReq.on('connect', (res, socket) => {
        sockets.add(socket);
        socket.on('error', () => { socket.destroy(); reject(); });
        if (finished || res.statusCode !== 200) { socket.destroy(); return reject(); }
        const headers = { 'User-Agent': UA, 'Referer': 'https://linkmake.in/' };
        if (cookie) headers.Cookie = cookie;
        const stallTimer = setTimeout(() => { socket.destroy(); reject('stall'); }, 4000);
        const req = https.get({ host: targetHost, socket, agent: false, path: reqPath, headers }, (res2) => {
          let data = '';
          res2.on('data', d => { clearTimeout(stallTimer); data += d; });
          res2.on('error', () => { clearTimeout(stallTimer); socket.destroy(); reject(); });
          res2.on('end', () => { clearTimeout(stallTimer); socket.destroy(); resolve({ status: res2.statusCode, data }); });
        });
        req.on('error', () => { clearTimeout(stallTimer); socket.destroy(); reject(); });
      });
      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => { proxyReq.destroy(); reject(); });
      proxyReq.end();
    });
  }

  const proxyPromises = pickProxies(10).map(proxy => (async () => {
    await headStart;
    if (finished) throw new Error('done');
    const { host: targetHost } = await targetP;
    let res = await proxyFetch(proxy, targetHost, targetPath);
    // if proxy hits the NginxAuth AES challenge (202 + slowAES), solve and retry via the same proxy IP
    if (res.status === 202 && res.data.includes('slowAES')) {
      const solved = parseDriveChallenge(res.data);
      if (solved) {
        res = await proxyFetch(proxy, targetHost, solved.nextPath || targetPath, solved.cookie);
      }
    }
    if (looksLikeFilesdlPage(res.data)) {
      WARM_PROXIES.set(proxy, Date.now());
      persistWarmProxies();
      return res.data;
    }
    WARM_PROXIES.delete(proxy);
    throw new Error('CF blocked proxy');
  })());

  // vercel free tier 10s limit; saare layers ek saath race mein
  let timer;
  const timeoutPromise = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 8500); });

  try {
    return await Promise.race([
      Promise.any([...directPromises, workerPromise, ...proxyPromises]),
      timeoutPromise
    ]);
  } catch (e) {
    console.warn(`[filesdl] all layers failed (${dltype}/${fid}):`, e?.message || e);
    return null;
  } finally {
    finished = true;
    clearTimeout(timer);
    sockets.forEach(s => s.destroy());
    proxyReqs.forEach(r => r.destroy());
  }
}

app.get('/api/servers', async (req, res) => {
  const { dltype, fid } = req.query;
  if (!['cloud', 'drive'].includes(dltype) || !fid) return res.status(400).json({ error: 'bad params' });

  const cKey = `servers:${dltype}:${fid}`;
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);

  try {
    const html = await fetchFilesdlHtml(dltype, fid, FD_HOSTS.get(fid));

    if (!html) {
      console.warn(`[servers] ${dltype}/${fid}: no page (all 3 layers failed)`);
      const payload = { cloud: null, fffast: null, reason: 'blocked' };
      cacheSet(cKey, payload, 5_000);
      return res.json(payload);
    }

    const { fffast, cloud: rawCloud, anchors } = parseServersHtml(html);
    let cloudUrl = null;
    if (rawCloud) {
      const token  = Math.floor(1000000000 + Math.random() * 9000000000);
      const rawUrl = rawCloud + (rawCloud.includes('?') ? '&' : '?') + 'token=' + token;
      cloudUrl = `${FD_WORKER}?s=${encodeURIComponent(WORKER_SECRET)}&url=${encodeURIComponent(rawUrl)}`;
    }

    const payload = { cloud: cloudUrl, fffast };
    if (!cloudUrl && !fffast) {
      // page loaded fine but we found neither: either the site stopped offering them for this file,
      // or it changed its markup (no recognisable download buttons at all)
      payload.reason = anchors === 0 ? 'format_changed' : 'not_offered';
      console.warn(`[servers] ${dltype}/${fid}: ${payload.reason} (${anchors} button anchors)`);
    }

    cacheSet(cKey, payload, payload.reason ? 5_000 : 300_000);
    res.json(payload);
  } catch (e) {
    console.error('[servers]', e.message);
    res.status(500).json({ error: 'failed' });
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
// admin password comes ONLY from the ADMIN_PASSWORD env var (no built-in default); unset = admin disabled
function adminAuth(password, res) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) { res.status(503).json({ ok: false, error: 'Admin disabled (ADMIN_PASSWORD not set)' }); return false; }
  const a = Buffer.from(String(password || '')), b = Buffer.from(real);
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, error: 'Wrong password' });
    return false;
  }
  return true;
}

app.post('/api/admin', async (req, res) => {
  const { password } = req.body || {};
  if (!adminAuth(password, res)) return;
  try {
    const logs  = await getLogs(300);
    const uuids = new Set(logs.map(l => l.uid).filter(Boolean));
    res.json({ ok: true, logs, stats: { uniqueUsers: uuids.size } });
  } catch { res.json({ ok: false, error: 'Failed to fetch logs' }); }
});

app.post('/api/admin/clear', async (req, res) => {
  const { password } = req.body || {};
  if (!adminAuth(password, res)) return;
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
    cacheSet(cKey, payload, 300_000);
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
    cacheSet(cKey, payload, 300_000);
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
    cacheSet(cKey, payload, 300_000);
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
    cacheSet(cKey, payload, 300_000);
    res.json(payload);
  } catch (e) {
    console.error('[pf/episodes]', e.message);
    res.status(500).json({ error: 'failed', buttons: [] });
  }
});

// latest movies — trending chips ke liye
function cleanTitle(t) {
  return (t || '').replace(/\s*\(?\d{4}\)?.*$/i, '').trim();
}
app.get('/api/latest', async (req, res) => {
  const cKey = 'latest:ff';
  const hit  = cacheGet(cKey);
  if (hit) return res.json(hit);
  try {
    const r = await fetch(
      'https://webfind.filmyflydla.space/latest',
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6_000) }
    );
    const data = await r.json();
    const items = (data.results || []).filter(item => !/\/404\.(png|webp|jpe?g)(\?|$)/i.test(item.poster || '')).slice(0, 8).map(item => ({
      title: cleanTitle(item.title),
      id:    String(item.filmyfly),
    }));
    const payload = { items };
    cacheSet(cKey, payload, 15 * 60_000);
    res.json(payload);
  } catch (e) {
    res.json({ items: [] });
  }
});


// health + a quick look at what the server currently believes (handy when something feels slow)
app.get('/api/health', (_, res) => res.json({
  ok: true,
  ts: Date.now(),
  domain: _domain,
  domainAgeMin: _domainTs ? Math.round((Date.now() - _domainTs) / 60_000) : null,
  proxies: cachedProxies.length,
  warmProxies: WARM_PROXIES.size,
  proxyListAgeMin: lastProxyFetch ? Math.round((Date.now() - lastProxyFetch) / 60_000) : null,
}));


app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// last-resort error handler: a bug in one route returns a clean JSON error instead of a hung/blank response
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  console.error('[unhandled route error]', req.path, err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'server error' });
});

// one bad socket / rejected promise must never take the whole process down
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message || e));
process.on('uncaughtException',  e => console.error('[uncaughtException]',  e && e.message || e));

// warm caches on startup — runs on Vercel too (require.main === module is false there)
activeDomain().catch(e => console.error('[domain]', e.message));
getFreshProxies().catch(() => {});
loadWarmProxiesFromRedis().catch(() => {});

if (require.main === module) {
  setInterval(() => activeDomain().catch(e => console.error('[domain]', e.message)), 55 * 60 * 1000);
  app.listen(PORT, () => console.log(`lallu → http://localhost:${PORT}`));
}
module.exports = app;
