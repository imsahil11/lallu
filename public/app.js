/* ============================================
   Lallu 🎬 — App Logic
   Token: Pure math, zero network, INSTANT ⚡
   ============================================ */

const $ = id => document.getElementById(id);

const state = {
  query: '',
  results: [],
  currentMovie: null,   // { title, info }
  currentFiles: [],
  currentSeason: null,
  currentEpLabel: null,
  _seasons: [],
  _episodes: null,      // { hasAll, episodes, poster }
};

// ── Screens ──────────────────────────────────
const SCREENS = ['hero','results','files','download'];
function showScreen(name) {
  SCREENS.forEach(s => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle('active', s === name);
  });
  window.scrollTo({ top:0, behavior:'smooth' });
}

// ── Token Gen (Pure Math — Instant ⚡) ───────
function bufToB64url(bytes) {
  let s = '';
  bytes.forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function makeToken(fileUniqueId, chatId, messageId) {
  const exp = Math.floor(Date.now()/1000) + 21600;
  const tb  = new ArrayBuffer(4);
  new DataView(tb).setUint32(0, exp >>> 0, false);
  const tp  = bufToB64url(new Uint8Array(tb));
  const cid = parseInt(String(chatId).replace('-100',''),10) >>> 0;
  const mb  = new ArrayBuffer(8);
  const mv  = new DataView(mb);
  mv.setUint32(0, cid, false);
  mv.setUint32(4, messageId >>> 0, false);
  const mp  = bufToB64url(new Uint8Array(mb));
  return (fileUniqueId||'xxx').substring(0,3) + tp + mp;
}
function buildUrls(token) {
  return { download: `https://potterstreaming.mgodyt2.workers.dev/${token}` };
}

// ── Helpers ───────────────────────────────────
function fmtSize(b) {
  if (!b) return '—';
  return b >= 1e9 ? `${(b/1e9).toFixed(2)} GB` : `${Math.round(b/1e6)} MB`;
}
function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function copyText(text, btnId) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = $(btnId);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    btn.style.color = 'var(--green)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
  });
}
function toast(msg, color = 'rgba(16,185,129,0.95)') {
  const t = $('toast');
  $('toastMsg').textContent = msg;
  t.style.background = color;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
function setMovieHeader(info) {
  $('movieHeaderInfo').innerHTML = `
    ${info.poster ? `<img class="movie-thumb" src="${esc(info.poster)}" alt="" onerror="this.style.display='none'">` : ''}
    <div>
      <div class="movie-header-title">${esc(info.title)}</div>
      ${info.year ? `<div class="movie-header-sub">📅 ${info.year} · ${info.mediaType==='tv' ? '📺 TV Series' : '🎬 Movie'}</div>` : ''}
    </div>`;
}
function showFilesLoading(msg = 'Load ho raha hai... 📁') {
  $('filesList').innerHTML = '';
  $('filesLoading').querySelector('p').textContent = msg;
  $('filesLoading').classList.add('visible');
}
function hideFilesLoading() {
  $('filesLoading').classList.remove('visible');
}

// ── Search ────────────────────────────────────
async function doSearch(q) {
  if (!q.trim()) return;
  state.query = q.trim();
  track('search', { query: state.query });
  showScreen('results');
  $('resultsQuery').textContent = state.query;
  $('resultsCount').textContent = '';
  $('resultsGrid').innerHTML = '';
  $('searchEmpty').style.display = 'none';
  $('searchLoading').classList.add('visible');

  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(state.query)}`);
    const data = await res.json();
    $('searchLoading').classList.remove('visible');
    if (!data.results?.length) { $('searchEmpty').style.display = 'flex'; return; }
    state.results = data.results;
    $('resultsCount').textContent = `${data.results.length} mili 🎉`;
    renderResults(data.results);
  } catch {
    $('searchLoading').classList.remove('visible');
    $('searchEmpty').style.display = 'flex';
  }
}

function renderResults(list) {
  const grid = $('resultsGrid');
  grid.innerHTML = '';
  list.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'movie-card';
    card.style.animationDelay = `${i*0.04}s`;
    const isTV = m.mediaType === 'tv';
    const r    = parseFloat(m.rating);
    card.innerHTML = `
      <div class="card-poster">
        ${m.poster
          ? `<img src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'card-no-poster\\'>🎬</div>'">`
          : `<div class="card-no-poster">🎬</div>`}
        <div class="card-overlay">
          <div class="card-play-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>
        ${r > 0 ? `<div class="card-rating">⭐ ${r.toFixed(1)}</div>` : ''}
        <div class="card-type-badge ${isTV ? 'type-tv' : 'type-movie'}">${isTV ? 'TV 📺' : 'Film 🎬'}</div>
      </div>
      <div class="card-info">
        <div class="card-title">${esc(m.title)}</div>
        ${m.year ? `<div class="card-year">📅 ${m.year}</div>` : ''}
      </div>`;
    card.addEventListener('click', () => onMediaClick(m));
    grid.appendChild(card);
  });
}

// ── Media Click Entry Point ───────────────────
async function onMediaClick(m) {
  state.currentMovie = { title: m.title, info: m };
  state.currentSeason = null;
  state.currentEpLabel = null;
  state._seasons = [];
  state._episodes = null;

  track('movie_click', { title: m.title, year: m.year, type: m.mediaType });

  if (m.mediaType === 'tv') {
    await loadSeasons(m);
  } else {
    const title = m.year ? `${m.title} ${m.year}` : m.title;
    await loadMovieFiles(title, m);
  }
}

// ─────────────────────────────────────────────
// STEP 1 (TV): Show Season Selector
// ─────────────────────────────────────────────
async function loadSeasons(info) {
  showScreen('files');
  setMovieHeader(info);
  showFilesLoading('Seasons load ho rahe hain... 📺');

  try {
    const res  = await fetch(`/api/seasons?title=${encodeURIComponent(info.title)}`);
    const data = await res.json();
    hideFilesLoading();

    if (!data.seasons?.length) {
      $('filesList').innerHTML = emptyHTML('Seasons nahi mile', 'Ye abhi available nahi hai');
      return;
    }

    state._seasons = data.seasons;
    renderSeasonSelector(info, data.seasons);
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Error aa gaya', 'Dobara try karo');
  }
}

function renderSeasonSelector(info, seasons) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-nav-header">
      <div class="tv-nav-title">📺 Season Select Karo</div>
    </div>
    <div class="tv-grid" id="tvGrid"></div>`;

  const grid = $('tvGrid');
  seasons.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'tv-btn';
    btn.style.animationDelay = `${i*0.05}s`;
    btn.innerHTML = `<div class="tv-btn-icon">📺</div><div class="tv-btn-label">Season ${s}</div>`;
    btn.addEventListener('click', () => loadEpisodes(info, s));
    grid.appendChild(btn);
  });
}

// ─────────────────────────────────────────────
// STEP 2 (TV): Show Episode Selector
// Exactly like Potterflix: "Complete Season" + "Episode 1", "Episode 2"...
// ─────────────────────────────────────────────
async function loadEpisodes(info, season) {
  state.currentSeason = season;
  showFilesLoading(`Season ${season} ke episodes load ho rahe hain... 🎬`);

  try {
    const res  = await fetch(`/api/episodes?title=${encodeURIComponent(info.title)}&season=${season}`);
    const data = await res.json();
    hideFilesLoading();

    state._episodes = data;
    renderEpisodeSelector(info, season, data);
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Error aa gaya', 'Dobara try karo');
  }
}

function renderEpisodeSelector(info, season, data) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-nav-header">
      <button class="tv-back-btn" id="backToSeasons">← Seasons</button>
      <div class="tv-nav-title">📺 ${esc(info.title)} — Season ${season}</div>
    </div>
    <div class="tv-grid" id="tvGrid"></div>`;

  $('backToSeasons').addEventListener('click', () => {
    state.currentSeason = null;
    renderSeasonSelector(info, state._seasons);
  });

  const grid = $('tvGrid');
  const buttons = data.buttons || [];

  if (!buttons.length) {
    list.insertAdjacentHTML('beforeend', emptyHTML('Koi episode nahi mila', 'Ye season abhi available nahi hai'));
    return;
  }

  // Render each button exactly as Potterflix shows it
  buttons.forEach((b, idx) => {
    const btn = document.createElement('button');
    // Complete Season gets a highlighted style
    btn.className = b.isComplete ? 'tv-btn tv-btn-complete' : 'tv-btn';
    btn.style.animationDelay = `${idx * 0.05}s`;
    const icon = b.isComplete ? '📦' : '🎬';
    btn.innerHTML = `<div class="tv-btn-icon">${icon}</div><div class="tv-btn-label">${esc(b.label)}</div>`;
    btn.addEventListener('click', () => {
      state.currentEpLabel = b.label;
      // b.path = "/Mirzapur/2/all" or "/Mirzapur/2/1"
      // tvPath = "Mirzapur/2/all" (strip leading slash)
      const tvPath = b.path.replace(/^\//, '');
      loadTVFiles(info, season, b.seg, b.label, tvPath);
    });
    grid.appendChild(btn);
  });
}



// ─────────────────────────────────────────────
// STEP 3 (TV): Load files for selected episode/all
// ─────────────────────────────────────────────
async function loadTVFiles(info, season, epOrAll, label, tvPath) {
  // tvPath comes directly from Potterflix button path (e.g. "Mirzapur/2/all" or "Mirzapur/2/1")
  // Fallback: reconstruct if not provided
  if (!tvPath) tvPath = `${info.title}/${season}/${epOrAll}`;

  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-nav-header">
      <button class="tv-back-btn" id="backToEpisodes">← Episodes</button>
      <div class="tv-nav-title">🎬 ${esc(info.title)} — S${season} · ${esc(label)}</div>
    </div>`;

  const loading = document.createElement('div');
  loading.className = 'loading-state visible';
  loading.innerHTML = '<div class="spinner-ring"></div><p>Files load ho rahi hain... 📁</p>';
  list.appendChild(loading);

  $('backToEpisodes').addEventListener('click', () => {
    renderEpisodeSelector(info, season, state._episodes);
  });

  try {
    const res  = await fetch(`/api/files?tvPath=${encodeURIComponent(tvPath)}`);
    const data = await res.json();
    loading.remove();

    if (!data.files?.length) {
      list.insertAdjacentHTML('beforeend', emptyHTML('Koi file nahi mili', 'Ye abhi available nahi hai'));
      return;
    }

    state.currentFiles = data.files;
    renderFilesList(data.files, list);
  } catch {
    loading.remove();
    list.insertAdjacentHTML('beforeend', emptyHTML('Error aa gaya', 'Dobara try karo'));
  }
}

// ─────────────────────────────────────────────
// Movie Files
// ─────────────────────────────────────────────
async function loadMovieFiles(title, info) {
  showScreen('files');
  setMovieHeader(info);
  showFilesLoading('Files load ho rahi hain... 📁');

  try {
    const res  = await fetch(`/api/files?title=${encodeURIComponent(title)}`);
    const data = await res.json();
    hideFilesLoading();

    if (!data.files?.length) {
      $('filesList').innerHTML = emptyHTML('Koi file nahi mili', 'Ye abhi available nahi hai');
      return;
    }
    state.currentFiles = data.files;
    renderFilesList(data.files, $('filesList'));
  } catch {
    hideFilesLoading();
  }
}

// ─────────────────────────────────────────────
// Render file cards
// ─────────────────────────────────────────────
function renderFilesList(files, containerEl) {
  const sorted = [...files].sort((a,b) => (b.quality||0)-(a.quality||0));
  sorted.forEach((f, i) => containerEl.appendChild(makeFileCard(f, i)));
}

function makeFileCard(f, i) {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.style.animationDelay = `${i*0.04}s`;
  const isDual = (f.languages||[]).length > 1;
  const langs  = (f.languages||[]).join(' + ') || '—';
  const qual   = f.quality ? `${f.quality}p` : 'HD';
  const size   = fmtSize(f.size);

  // Show both title (file_name style short) and subtitle (caption = full info)
  // Use caption as main name since it's richer
  const mainName = f.name || f.caption || '—';

  card.innerHTML = `
    <div class="file-icon">🎞️</div>
    <div class="file-info">
      <div class="file-name" title="${esc(mainName)}">${esc(mainName)}</div>
      <div class="file-badges">
        <span class="badge badge-quality">🏆 ${qual}</span>
        <span class="badge badge-size">💾 ${size}</span>
        <span class="badge badge-lang">🎧 ${langs}</span>
        ${isDual ? '<span class="badge badge-dual">🌍 DUAL</span>' : ''}
      </div>
    </div>
    <div class="file-arrow">›</div>`;
  card.addEventListener('click', () => openDownload(f));
  return card;
}

function emptyHTML(title, sub) {
  return `<div class="empty-state visible"><div class="empty-icon">😕</div><h3>${title}</h3><p>${sub}</p></div>`;
}

// ── Download Page ─────────────────────────────
function openDownload(file) {
  showScreen('download');
  const qual  = file.quality ? `${file.quality}p` : 'HD';
  const size  = fmtSize(file.size);
  const langs = (file.languages||[]).join(' + ') || '—';

  $('downloadCard').innerHTML = `
    <div class="dl-card">
      <div class="dl-top-bar"></div>
      <div class="dl-header">
        <div class="dl-file-icon">🎬</div>
        <div class="dl-title">${esc(file.name || file.caption)}</div>
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
        <div class="dl-info-pill">
          <span>⚡</span>
          <span>Ek click mein <strong>instant links</strong> mil jaayenge — 6 ghante valid hain 🕐</span>
        </div>
        <button class="btn-gen" id="generateBtn">✨ Links Generate Karo</button>
        <div class="action-sections" id="actionSections">
          <div class="action-card download-card-inner">
            <div class="action-card-header">
              <div class="action-icon dl-icon-sm">⬇️</div>
              <div class="action-card-info">
                <div class="action-card-title">⚡ Direct Download</div>
                <div class="action-card-sub">Device mein save karo · Full speed</div>
              </div>
              <button class="btn-copy-link" id="copyDlBtn">📋 Copy</button>
            </div>
            <a class="btn-dl" id="downloadBtn" href="#" target="_blank" rel="noopener noreferrer">
              ⬇️ Download Karo
            </a>
          </div>
          <div class="expire-row">⏱️ <span id="expireText">Links 6 ghante valid hain</span></div>
        </div>
      </div>
    </div>`;

  $('generateBtn').addEventListener('click', () => generateLinks(file));
}

// ── Generate (Instant — no network) ──────────
function generateLinks(file) {
  const btn = $('generateBtn');
  btn.disabled = true;
  btn.textContent = '✅ Links Ready!';
  btn.style.background = 'linear-gradient(135deg,#059669,#10b981)';

  // Track download
  track('download_click', {
    title: file.name || file.caption,
    quality: file.quality,
    size: fmtSize(file.size),
    languages: (file.languages || []).join('+'),
  });

  const token = makeToken(file.fileUniqueId, file.chatId, file.messageId);
  const urls  = buildUrls(token);

  $('actionSections').classList.add('visible');
  $('downloadBtn').href = urls.download;
  $('copyDlBtn').addEventListener('click', () => {
    copyText(urls.download, 'copyDlBtn');
    toast('⬇️ Download link copy ho gaya!');
  });

  startCountdown(file);
}

// ── Countdown ─────────────────────────────────
function startCountdown(file) {
  const el  = $('expireText');
  if (!el) return;
  const end = Date.now() + 6*3600*1000;

  const tick = () => {
    const rem = Math.max(0, end - Date.now());
    if (rem === 0) {
      el.textContent = '❌ Links expire ho gaye — dobara generate karo';
      el.style.color = 'var(--red)';
      clearInterval(t);
      const btn = $('generateBtn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Dobara Generate Karo';
        btn.style.background = '';
        $('actionSections').classList.remove('visible');
        btn.addEventListener('click', () => generateLinks(file), { once:true });
      }
      return;
    }
    const h = Math.floor(rem/3600000);
    const m = Math.floor((rem%3600000)/60000);
    const s = Math.floor((rem%60000)/1000);
    el.textContent = h > 0
      ? `⏱️ ${h}h ${m}m baad expire honge`
      : `⏱️ ${m}m ${s}s baad expire honge`;
  };

  const t = setInterval(tick, 1000);
  tick();
}

// ── Analytics Tracker ─────────────────────────
// Fire-and-forget — never blocks the UI
function track(action, data = {}) {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  }).catch(() => {}); // silent fail
}

// ── Admin Panel ───────────────────────────────
function openAdminPanel() {
  $('adminOverlay').classList.add('open');
  $('adminPassInput').focus();
}
function closeAdminPanel() {
  $('adminOverlay').classList.remove('open');
  // Reset to auth screen
  $('adminAuth').style.display = '';
  $('adminLogs').style.display = 'none';
  $('adminPassInput').value = '';
  $('adminPassErr').textContent = '';
}

async function submitAdminPassword() {
  const pass = $('adminPassInput').value;
  const btn  = $('adminPassBtn');
  if (!pass) return;
  btn.disabled = true;
  btn.textContent = 'Checking...';
  $('adminPassErr').textContent = '';

  try {
    const res  = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    });
    const data = await res.json();

    if (!data.ok) {
      $('adminPassErr').textContent = '❌ Wrong password';
      $('adminPassInput').value = '';
      $('adminPassInput').focus();
    } else {
      $('adminAuth').style.display = 'none';
      $('adminLogs').style.display = 'flex';
      renderAdminLogs(data.logs || []);
    }
  } catch {
    $('adminPassErr').textContent = '❌ Server error, try again';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock →';
  }
}

function actionLabel(action) {
  const map = {
    search:    '🔍 Search',
    movie_click: '🎬 Clicked',
    season_click: '📺 Season',
    episode_click: '▶️ Episode',
    download_click: '⬇️ Download',
  };
  return map[action] || action;
}

function renderAdminLogs(logs) {
  const statsEl = $('adminStatsRow');
  const listEl  = $('adminLogList');

  // Stats
  const total     = logs.length;
  const searches  = logs.filter(l => l.action === 'search').length;
  const downloads = logs.filter(l => l.action === 'download_click').length;
  const devices   = new Set(logs.map(l => l.device)).size;

  statsEl.innerHTML = `
    <div class="admin-stat"><span class="admin-stat-num">${total}</span>Events</div>
    <div class="admin-stat"><span class="admin-stat-num">${searches}</span>Searches</div>
    <div class="admin-stat"><span class="admin-stat-num">${downloads}</span>Downloads</div>
    <div class="admin-stat"><span class="admin-stat-num">${devices}</span>Devices</div>`;

  if (!logs.length) {
    listEl.innerHTML = '<div class="admin-empty">📭 Abhi tak koi activity nahi</div>';
    return;
  }

  listEl.innerHTML = '';
  logs.forEach(log => {
    const entry = document.createElement('div');
    entry.className = 'admin-log-entry';

    // Build detail string from data
    const d = log.data || {};
    let detail = '';
    if (d.query)   detail = `"${d.query}"`;
    else if (d.title && d.quality) detail = `${d.title} · ${d.quality}p`;
    else if (d.title) detail = d.title;
    else if (d.season) detail = `Season ${d.season}`;
    else if (d.episode) detail = `Episode ${d.episode}`;

    entry.innerHTML = `
      <div class="admin-log-top">
        <span class="admin-log-device">📱 ${esc(log.device)} · ${esc(log.browser)}</span>
        <span class="admin-log-time">${esc(log.time)}</span>
      </div>
      <div class="admin-log-action">${actionLabel(log.action)}${detail ? ` — ` : ''}<span class="admin-log-detail">${esc(detail)}</span></div>
      <div class="admin-log-detail" style="margin-top:3px;opacity:.6">${esc(log.os)}</div>`;
    listEl.appendChild(entry);
  });
}

// ── Events ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const si = $('searchInput');
  const sb = $('searchBtn');

  si.addEventListener('keydown', e => { if (e.key==='Enter') doSearch(si.value); });
  sb.addEventListener('click', () => doSearch(si.value));

  document.querySelectorAll('.qs-chip').forEach(c =>
    c.addEventListener('click', () => { si.value = c.dataset.query; doSearch(c.dataset.query); })
  );

  $('navSearchTrigger')?.addEventListener('click', () => { showScreen('hero'); setTimeout(() => si.focus(), 150); });
  document.querySelector('.nav-logo')?.addEventListener('click', () => showScreen('hero'));
  $('navLogo')?.addEventListener('click', () => showScreen('hero'));

  $('backToHero')?.addEventListener('click', () => showScreen('hero'));
  $('backToResults')?.addEventListener('click', () => showScreen('results'));

  $('backToFiles')?.addEventListener('click', () => {
    const info = state.currentMovie?.info;
    if (!info) { showScreen('results'); return; }
    if (info.mediaType === 'tv') {
      if (state.currentEpLabel) {
        renderEpisodeSelector(info, state.currentSeason, state._episodes);
      } else if (state.currentSeason) {
        renderSeasonSelector(info, state._seasons);
      } else {
        showScreen('results');
      }
    } else {
      showScreen('results');
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.metaKey||e.ctrlKey) && e.key==='k') {
      e.preventDefault(); showScreen('hero'); setTimeout(() => si.focus(), 100);
    }
    if (e.key === 'Escape') closeAdminPanel();
  });

  // Settings FAB
  $('settingsFab')?.addEventListener('click', openAdminPanel);
  $('adminClose')?.addEventListener('click', closeAdminPanel);
  $('adminOverlay')?.addEventListener('click', e => { if (e.target === $('adminOverlay')) closeAdminPanel(); });
  $('adminPassBtn')?.addEventListener('click', submitAdminPassword);
  $('adminPassInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitAdminPassword(); });

  showScreen('hero');
  si.focus();
});
