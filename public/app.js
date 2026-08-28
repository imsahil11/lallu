/* =====================================================
   Lallu 🎬 — App Logic v2
   UUID tracking · Client Hints · Clean state machine
   ===================================================== */

'use strict';

// ── Utilities ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtSize(b) {
  if (!b || b === 0) return '—';
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`;
}

function toast(msg) {
  const el  = $('toast');
  $('toastMsg').textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// Show/hide helpers — use style.display directly, no hidden attribute conflicts
function showEl(id, display = 'flex') { const el = $(id); if (el) el.style.display = display; }
function hideEl(id)                   { const el = $(id); if (el) el.style.display = 'none'; }

// ── UUID — persistent user identity ───────────────────────────────────────────
function getUID() {
  const KEY = 'lallu_uid';
  let uid = localStorage.getItem(KEY);
  if (!uid) {
    // UUID v4 generation — no crypto dependency needed, pure math
    uid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
    localStorage.setItem(KEY, uid);
  }
  return uid;
}

const UID = getUID();

// ── Client Hints — real device name on Android Chrome ─────────────────────────
let _clientHints = null;
async function fetchClientHints() {
  try {
    if (!navigator.userAgentData) return null;
    const h = await navigator.userAgentData.getHighEntropyValues([
      'platform', 'platformVersion', 'mobile', 'model',
    ]);
    _clientHints = {
      platform       : h.platform || null,
      platformVersion: h.platformVersion || null,
      mobile         : h.mobile ?? false,
      model          : h.model || null,       // e.g. "Redmi Note 12" on Android Chrome
    };
    return _clientHints;
  } catch { return null; }
}

// ── Analytics — fire and forget ────────────────────────────────────────────────
function track(action, data = {}) {
  const payload = {
    action,
    data,
    uid        : UID,
    clientHints: _clientHints,
  };
  fetch('/api/track', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

// ── Token generation — pure math, no network needed ───────────────────────────
function b64url(bytes) {
  let s = '';
  bytes.forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeToken(fileUniqueId, chatId, messageId) {
  const exp = Math.floor(Date.now() / 1000) + 21600;     // 6h from now
  const tb  = new ArrayBuffer(4);
  new DataView(tb).setUint32(0, exp >>> 0, false);
  const tp = b64url(new Uint8Array(tb));

  const cid = parseInt(String(chatId).replace('-100', ''), 10) >>> 0;
  const mb  = new ArrayBuffer(8);
  const mv  = new DataView(mb);
  mv.setUint32(0, cid, false);
  mv.setUint32(4, messageId >>> 0, false);
  const mp = b64url(new Uint8Array(mb));

  return (fileUniqueId || 'xxx').substring(0, 3) + tp + mp;
}

function dlUrl(token) {
  return `https://potterstreaming.mgodyt2.workers.dev/${token}`;
}

// ── State ──────────────────────────────────────────────────────────────────────
const S = {
  query      : '',
  results    : [],
  movie      : null,   // { title, info }
  files      : [],
  season     : null,
  epLabel    : null,
  seasons    : [],
  episodes   : null,   // { buttons, poster }
};

// ── Screen router ──────────────────────────────────────────────────────────────
const SCREENS = ['hero', 'results', 'files', 'download'];

// Each screen has the correct display value it should use when visible.
// JS owns display entirely — no CSS hidden-attribute conflicts possible.
const SCREEN_DISPLAY = {
  hero    : 'flex',   // needs flex for vertical centering
  results : 'block',
  files   : 'block',
  download: 'block',
};

function show(name) {
  SCREENS.forEach(id => {
    const el = $(`s-${id}`);
    if (!el) return;
    el.style.display = id === name ? (SCREEN_DISPLAY[id] || 'block') : 'none';
  });

  // Show "🔍 Search" home button in nav on all screens except hero
  const homeBtn = $('navHomeBtn');
  if (homeBtn) homeBtn.style.display = name === 'hero' ? 'none' : 'flex';

  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── Search ─────────────────────────────────────────────────────────────────────
let _searchCtrl = null;   // AbortController — cancels previous in-flight search

async function doSearch(q) {
  q = (q || '').trim();
  if (!q) return;

  // Cancel any previous in-flight search
  if (_searchCtrl) _searchCtrl.abort();
  _searchCtrl = new AbortController();
  const signal = _searchCtrl.signal;

  S.query = q;
  track('search', { query: q });

  show('results');
  $('resultsQuery').textContent = q;
  const badge = $('resultsCount');
  badge.textContent = '';
  badge.classList.remove('show');
  $('resultsGrid').innerHTML = '';
  hideEl('searchEmpty');
  showEl('searchLoading');

  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
    const data = await res.json();
    hideEl('searchLoading');

    if (!data.results?.length) {
      showEl('searchEmpty');
      return;
    }
    S.results = data.results;
    badge.textContent = `${data.results.length} mili 🎉`;
    badge.classList.add('show');
    renderCards(data.results);
  } catch (err) {
    if (err.name === 'AbortError') return;    // intentionally cancelled — ignore
    hideEl('searchLoading');
    showEl('searchEmpty');
  }
}

function renderCards(list) {
  const grid = $('resultsGrid');
  grid.innerHTML = '';

  // Use DocumentFragment to batch DOM writes
  const frag = document.createDocumentFragment();
  list.forEach(m => {
    const card = makeCard(m);
    frag.appendChild(card);
  });
  grid.appendChild(frag);
}

function makeCard(m) {
  const isTV = m.mediaType === 'tv';
  const r    = parseFloat(m.rating);

  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'listitem');

  card.innerHTML = `
    <div class="card-poster">
      ${m.poster
        ? `<img src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy" decoding="async"
             sizes="(max-width:480px) 30vw,(max-width:640px) 22vw,155px"
             class="loading" onload="this.classList.remove('loading')"
             onerror="this.parentElement.innerHTML='<div class=\\'card-no-poster\\'>🎬</div>'">`
        : `<div class="card-no-poster">🎬</div>`}
      ${r > 0 ? `<div class="card-rating">⭐ ${r.toFixed(1)}</div>` : ''}
      <div class="card-type ${isTV ? 'type-tv' : 'type-movie'}">${isTV ? 'TV' : 'Film'}</div>
    </div>
    <div class="card-info">
      <div class="card-title">${esc(m.title)}</div>
      ${m.year ? `<div class="card-year">${m.year}</div>` : ''}
    </div>`;

  card.addEventListener('click', () => onMediaClick(m), { passive: true });
  return card;
}

// ── Media click → entry point ──────────────────────────────────────────────────
async function onMediaClick(m) {
  S.movie   = { title: m.title, info: m };
  S.season  = null;
  S.epLabel = null;
  S.seasons = [];
  S.episodes = null;

  track('movie_click', { title: m.title, year: m.year, type: m.mediaType });

  if (m.mediaType === 'tv') {
    await loadSeasons(m);
  } else {
    const title = m.year ? `${m.title} ${m.year}` : m.title;
    await loadMovieFiles(title, m);
  }
}

// ── TV: Step 1 — Seasons ───────────────────────────────────────────────────────
async function loadSeasons(info) {
  show('files');
  setMovieHead(info);
  setFilesLoading('Seasons load ho rahe hain... 📺');

  try {
    const res  = await fetch(`/api/seasons?title=${encodeURIComponent(info.title)}`);
    const data = await res.json();
    hideFilesLoading();

    if (!data.seasons?.length) {
      $('filesList').innerHTML = emptyHTML('Seasons nahi mile', 'Ye abhi available nahi hai');
      return;
    }
    S.seasons = data.seasons;
    renderSeasons(info, data.seasons);
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Error aa gaya', 'Dobara try karo');
  }
}

function renderSeasons(info, seasons) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-head">
      <div class="tv-head-title">📺 Season Select Karo</div>
    </div>
    <div class="tv-grid" id="tvGrid"></div>`;

  const grid = $('tvGrid');
  seasons.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'tv-btn';
    btn.innerHTML = `<div class="tv-btn-ico">📺</div><div class="tv-btn-lbl">Season ${s}</div>`;
    btn.addEventListener('click', () => loadEpisodes(info, s), { passive: true });
    grid.appendChild(btn);
  });
}

// ── TV: Step 2 — Episodes ─────────────────────────────────────────────────────
async function loadEpisodes(info, season) {
  S.season = season;
  setFilesLoading(`Season ${season} ke episodes... 🎬`);

  try {
    const res  = await fetch(`/api/episodes?title=${encodeURIComponent(info.title)}&season=${season}`);
    const data = await res.json();
    hideFilesLoading();
    S.episodes = data;
    renderEpisodes(info, season, data);
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Error aa gaya', 'Dobara try karo');
  }
}

function renderEpisodes(info, season, data) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-head">
      <button class="tv-back" id="backToSeasons">← Seasons</button>
      <div class="tv-head-title">${esc(info.title)} — S${season}</div>
    </div>
    <div class="tv-grid" id="tvGrid"></div>`;

  $('backToSeasons').addEventListener('click', () => {
    S.season = null;
    renderSeasons(info, S.seasons);
  }, { passive: true });

  const grid    = $('tvGrid');
  const buttons = data.buttons || [];

  if (!buttons.length) {
    list.insertAdjacentHTML('beforeend', emptyHTML('Koi episode nahi mila', 'Ye season available nahi hai'));
    return;
  }

  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = b.isComplete ? 'tv-btn tv-btn-complete' : 'tv-btn';
    btn.innerHTML = `
      <div class="tv-btn-ico">${b.isComplete ? '📦' : '🎬'}</div>
      <div class="tv-btn-lbl">${esc(b.label)}</div>`;
    btn.addEventListener('click', () => {
      S.epLabel = b.label;
      loadTVFiles(info, season, b.seg, b.label, b.path.replace(/^\//, ''));
    }, { passive: true });
    grid.appendChild(btn);
  });
}

// ── TV: Step 3 — Files for episode/season ─────────────────────────────────────
async function loadTVFiles(info, season, segOrAll, label, tvPath) {
  if (!tvPath) tvPath = `${info.title}/${season}/${segOrAll}`;

  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-head">
      <button class="tv-back" id="backToEpisodes">← Episodes</button>
      <div class="tv-head-title">${esc(info.title)} — S${season} · ${esc(label)}</div>
    </div>`;

  $('backToEpisodes').addEventListener('click', () => {
    renderEpisodes(info, season, S.episodes);
  }, { passive: true });

  const spinEl = document.createElement('div');
  spinEl.className = 'state-wrap';
  spinEl.style.display = 'flex';
  spinEl.innerHTML = '<div class="spinner"></div><p>Files load ho rahi hain... 📁</p>';
  list.appendChild(spinEl);

  try {
    const res  = await fetch(`/api/files?tvPath=${encodeURIComponent(tvPath)}`);
    const data = await res.json();
    spinEl.remove();

    if (!data.files?.length) {
      list.insertAdjacentHTML('beforeend', emptyHTML('Koi file nahi mili', 'Ye abhi available nahi hai'));
      return;
    }
    S.files = data.files;
    renderFiles(data.files, list);
  } catch {
    spinEl.remove();
    list.insertAdjacentHTML('beforeend', emptyHTML('Error aa gaya', 'Dobara try karo'));
  }
}

// ── Movie: direct files ────────────────────────────────────────────────────────
async function loadMovieFiles(title, info) {
  show('files');
  setMovieHead(info);
  setFilesLoading('Files load ho rahi hain... 📁');

  try {
    const res  = await fetch(`/api/files?title=${encodeURIComponent(title)}`);
    const data = await res.json();
    hideFilesLoading();

    if (!data.files?.length) {
      $('filesList').innerHTML = emptyHTML('Koi file nahi mili', 'Ye abhi available nahi hai');
      return;
    }
    S.files = data.files;
    renderFiles(data.files, $('filesList'));
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Error aa gaya', 'Dobara try karo');
  }
}

// ── Render file cards ──────────────────────────────────────────────────────────
function renderFiles(files, container) {
  // Sort: highest quality first
  const sorted = [...files].sort((a, b) => (b.quality || 0) - (a.quality || 0));
  const frag   = document.createDocumentFragment();
  sorted.forEach(f => frag.appendChild(makeFileCard(f)));
  container.appendChild(frag);
}

function makeFileCard(f) {
  const card    = document.createElement('div');
  card.className = 'file-card';
  const qual    = f.quality ? `${f.quality}p` : 'HD';
  const size    = fmtSize(f.size);
  const langs   = (f.languages || []).join(' + ') || '—';
  const isDual  = (f.languages || []).length > 1;
  const name    = f.name || f.caption || '—';

  card.innerHTML = `
    <div class="file-ico">🎞️</div>
    <div class="file-meta">
      <div class="file-name" title="${esc(name)}">${esc(name)}</div>
      <div class="file-tags">
        <span class="tag tag-q">🏆 ${qual}</span>
        <span class="tag tag-s">💾 ${size}</span>
        <span class="tag tag-l">🎧 ${langs}</span>
        ${isDual ? '<span class="tag tag-d">🌍 DUAL</span>' : ''}
      </div>
    </div>
    <div class="file-arrow">›</div>`;

  card.addEventListener('click', () => openDownload(f), { passive: true });
  return card;
}

function emptyHTML(title, sub) {
  return `<div class="state-wrap" style="display:flex">
    <div class="state-icon">😕</div>
    <h3>${esc(title)}</h3>
    <p>${esc(sub)}</p>
  </div>`;
}

// ── Helper: movie head in files screen ────────────────────────────────────────
function setMovieHead(info) {
  $('movieHead').innerHTML = `
    ${info.poster ? `<img class="movie-thumb" src="${esc(info.poster)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
    <div>
      <div class="movie-head-title">${esc(info.title)}</div>
      ${info.year ? `<div class="movie-head-sub">📅 ${info.year} · ${info.mediaType === 'tv' ? '📺 Series' : '🎬 Movie'}</div>` : ''}
    </div>`;
}

function setFilesLoading(msg) {
  $('filesList').innerHTML = '';
  $('filesLoadingMsg').textContent = msg;
  showEl('filesLoading');
}

function hideFilesLoading() {
  hideEl('filesLoading');
}

// ── Download screen ────────────────────────────────────────────────────────────
function openDownload(file) {
  show('download');
  const qual  = file.quality ? `${file.quality}p` : 'HD';
  const size  = fmtSize(file.size);
  const langs = (file.languages || []).join(' + ') || '—';
  const name  = file.name || file.caption || '—';
  const hasShare = !!navigator.share;

  $('dlCard').innerHTML = `
    <div class="dl-bar"></div>
    <div class="dl-header">
      <div class="dl-icon">🎬</div>
      <div class="dl-title">${esc(name)}</div>
    </div>
    <div class="dl-meta">
      <div class="dl-meta-item">
        <span class="dl-meta-emoji">🏆</span>
        <span class="dl-meta-label">Quality</span>
        <span class="dl-meta-val">${qual}</span>
      </div>
      <div class="dl-meta-item">
        <span class="dl-meta-emoji">💾</span>
        <span class="dl-meta-label">Size</span>
        <span class="dl-meta-val">${size}</span>
      </div>
      <div class="dl-meta-item">
        <span class="dl-meta-emoji">🎧</span>
        <span class="dl-meta-label">Audio</span>
        <span class="dl-meta-val" style="font-size:.7rem">${langs}</span>
      </div>
    </div>
    <div class="dl-body">
      <div class="dl-pill">
        <span class="dl-pill-ico">⚡</span>
        <span>Ek click mein <strong>instant link</strong> milega — 6 ghante valid hoga 🕐</span>
      </div>
      <button class="btn-gen" id="genBtn">✨ Link Generate Karo</button>
      <div class="dl-actions" id="dlActions">
        <div class="dl-action-card">
          <div class="dl-action-top">
            <div class="dl-action-ico">⬇️</div>
            <div class="dl-action-info">
              <div class="dl-action-title">⚡ Direct Download</div>
              <div class="dl-action-sub">Device mein save karo · Full speed</div>
            </div>
            <div class="dl-action-btns">
              <button class="btn-copy" id="copyBtn">📋 Copy</button>
              ${hasShare ? '<button class="btn-share" id="shareBtn">📤 Share</button>' : ''}
            </div>
          </div>
          <a class="btn-dl" id="dlBtn" href="#" target="_blank" rel="noopener noreferrer">
            ⬇️ Download Karo
          </a>
        </div>
        <div class="expire-row" id="expireRow">Links 6 ghante valid hain ⏱️</div>
      </div>
    </div>`;

  $('genBtn').addEventListener('click', () => generateLink(file, name), { once: true });
}

// ── Generate link (pure client-side, instant) ──────────────────────────────────
function generateLink(file, name) {
  const btn = $('genBtn');
  btn.disabled = true;
  btn.textContent = '✅ Link Ready!';

  track('download_click', {
    title    : file.name || file.caption,
    quality  : file.quality,
    size     : fmtSize(file.size),
    languages: (file.languages || []).join('+'),
  });

  const token = makeToken(file.fileUniqueId, file.chatId, file.messageId);
  const url   = dlUrl(token);

  $('dlBtn').href = url;

  $('copyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(url)
      .then(() => toast('📋 Link copy ho gaya!'))
      .catch(() => {});
  }, { passive: true });

  // Native share — Android/iOS share sheet
  const shareBtn = $('shareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      navigator.share({
        title: name || 'Download Link',
        text : `🎬 ${name || 'Movie'} download karo — 6 ghante valid`,
        url  : url,
      }).catch(() => {});
    }, { passive: true });
  }

  $('dlActions').classList.add('show');
  startCountdown(file, $('expireRow'), name);
}

// ── Countdown — rAF-based, no setInterval ─────────────────────────────────────
function startCountdown(file, el, name) {
  const end = Date.now() + 6 * 3600 * 1000;
  let rafId;

  function tick() {
    const rem = Math.max(0, end - Date.now());

    if (rem === 0) {
      el.textContent = '❌ Link expire ho gaya — dobara generate karo';
      el.style.color = 'var(--red)';
      cancelAnimationFrame(rafId);

      const btn = $('genBtn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Dobara Generate Karo';
        $('dlActions').classList.remove('show');
        btn.addEventListener('click', () => generateLink(file, name), { once: true });
      }
      return;
    }

    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    el.textContent = h > 0
      ? `⏱️ ${h}h ${m}m baad expire hoga`
      : `⏱️ ${m}m ${s}s baad expire hoga`;

    // Update every second using rAF — but throttle to ~1s
    setTimeout(() => { rafId = requestAnimationFrame(tick); }, 1000);
  }

  rafId = requestAnimationFrame(tick);
}

// ── Admin panel ────────────────────────────────────────────────────────────────
function openAdmin() {
  showEl('adminOverlay', 'flex');
  $('adminPassInput').focus();
}
function closeAdmin() {
  hideEl('adminOverlay');
  showEl('adminAuth', 'block');
  hideEl('adminLogs');
  $('adminPassInput').value = '';
  $('adminPassErr').textContent = '';
}

async function submitAdminPass() {
  const pass = $('adminPassInput').value;
  const btn  = $('adminPassBtn');
  if (!pass) return;

  btn.disabled = true;
  btn.textContent = 'Checking...';
  $('adminPassErr').textContent = '';

  try {
    const res  = await fetch('/api/admin', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ password: pass }),
    });
    const data = await res.json();

    if (!data.ok) {
      $('adminPassErr').textContent = '❌ Wrong password';
      $('adminPassInput').value = '';
      $('adminPassInput').focus();
    } else {
      hideEl('adminAuth');
      showEl('adminLogs', 'flex');
      renderAdminLogs(data.logs || [], data.stats || {});
    }
  } catch {
    $('adminPassErr').textContent = '❌ Server error, try again';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock →';
  }
}

const ACTION_LABEL = {
  search        : '🔍 Search',
  movie_click   : '🎬 Clicked',
  season_click  : '📺 Season',
  episode_click : '▶️ Episode',
  download_click: '⬇️ Download',
};

function renderAdminLogs(logs, stats) {
  const statsEl = $('adminStats');
  const listEl  = $('adminLogList');

  const searches  = logs.filter(l => l.action === 'search').length;
  const downloads = logs.filter(l => l.action === 'download_click').length;
  const uids      = new Set(logs.map(l => l.uid).filter(Boolean)).size;

  statsEl.innerHTML = `
    <div class="admin-stat"><span class="admin-stat-n">${logs.length}</span><span class="admin-stat-l">Events</span></div>
    <div class="admin-stat"><span class="admin-stat-n">${uids || stats.uniqueUsers || 0}</span><span class="admin-stat-l">Users</span></div>
    <div class="admin-stat"><span class="admin-stat-n">${searches}</span><span class="admin-stat-l">Searches</span></div>
    <div class="admin-stat"><span class="admin-stat-n">${downloads}</span><span class="admin-stat-l">Downloads</span></div>`;

  if (!logs.length) {
    listEl.innerHTML = '<div class="admin-empty">📭 Abhi tak koi activity nahi</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  logs.forEach(log => {
    const d      = log.data || {};
    let detail   = '';
    if (d.query)               detail = `"${d.query}"`;
    else if (d.title && d.quality) detail = `${d.title} · ${d.quality}p`;
    else if (d.title)          detail = d.title;
    else if (d.season)         detail = `Season ${d.season}`;

    const shortUid = log.uid ? log.uid.substring(0, 8) : null;

    const entry = document.createElement('div');
    entry.className = 'admin-log-entry';
    entry.innerHTML = `
      <div class="admin-log-row1">
        <span class="admin-log-device">📱 ${esc(log.device)}</span>
        <span class="admin-log-time">${esc(log.time)}</span>
      </div>
      <div class="admin-log-action">${ACTION_LABEL[log.action] || log.action}${detail ? ` — ${esc(detail)}` : ''}</div>
      <div class="admin-log-meta">${esc(log.os)} · ${esc(log.browser)}</div>
      ${shortUid ? `<span class="admin-log-uid">uid: ${esc(shortUid)}</span>` : ''}`;
    frag.appendChild(entry);
  });
  listEl.innerHTML = '';
  listEl.appendChild(frag);
}

// ── Back navigation ────────────────────────────────────────────────────────────
function handleBackToFiles() {
  const info = S.movie?.info;
  if (!info) { show('results'); return; }

  if (info.mediaType === 'tv') {
    if (S.epLabel && S.episodes) {
      // On download → back: go to episode selector, clear epLabel so next back goes to seasons
      S.epLabel = null;
      renderEpisodes(info, S.season, S.episodes);
      show('files');
    } else if (S.season !== null) {
      // On episodes → back: go to season selector, clear season
      S.season = null;
      renderSeasons(info, S.seasons);
      show('files');
    } else {
      show('results');
    }
  } else {
    show('results');
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Kick off Client Hints fetch early (non-blocking)
  fetchClientHints();

  const si = $('searchInput');
  const sb = $('searchBtn');

  // Search events
  si.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch(si.value);
  });
  sb.addEventListener('click', () => doSearch(si.value), { passive: true });

  // Quick chips
  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      si.value = c.dataset.query;
      doSearch(c.dataset.query);
    }, { passive: true });
  });

  // Navbar — logo always goes home, home button appears on non-hero screens
  $('navLogo')?.addEventListener('click', () => {
    show('hero');
    setTimeout(() => si.focus(), 60);
  }, { passive: true });
  $('navHomeBtn')?.addEventListener('click', () => {
    show('hero');
    setTimeout(() => si.focus(), 60);
  }, { passive: true });

  // Back buttons
  $('backToHero')?.addEventListener('click', () => show('hero'), { passive: true });
  $('backToResults')?.addEventListener('click', () => show('results'), { passive: true });
  $('backToFiles')?.addEventListener('click', handleBackToFiles, { passive: true });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      show('hero');
      setTimeout(() => si.focus(), 80);
    }
    if (e.key === 'Escape') closeAdmin();
  });

  // Admin
  $('adminFab')?.addEventListener('click', openAdmin, { passive: true });
  $('adminClose')?.addEventListener('click', closeAdmin, { passive: true });
  $('adminPassBtn')?.addEventListener('click', submitAdminPass, { passive: true });
  $('adminPassInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitAdminPass();
  });
  $('adminOverlay')?.addEventListener('click', e => {
    if (e.target === $('adminOverlay')) closeAdmin();
  }, { passive: true });

  // Init
  show('hero');
  si.focus();
});
