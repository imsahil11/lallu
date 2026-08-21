/* ============================================
   Lallu 🎬 — App Logic
   Token: Pure math, zero network, INSTANT ⚡
   ============================================ */

const $ = id => document.getElementById(id);

const state = { query:'', results:[], currentMovie:null, currentFiles:[], currentSeason:null };

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
  return {
    download: `https://potterstreaming.mgodyt2.workers.dev/${token}`,
  };
}

// ── Helpers ──────────────────────────────────
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

// ── Search ────────────────────────────────────
async function doSearch(q) {
  if (!q.trim()) return;
  state.query = q.trim();
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
    card.addEventListener('click', () => {
      loadMedia(m);
    });
    grid.appendChild(card);
  });
}

// ── Load Media (Movie or TV) ──────────────────
async function loadMedia(m) {
  state.currentMovie = { title: m.title, info: m };
  state.currentSeason = null;

  if (m.mediaType === 'tv') {
    await loadTVSeries(m);
  } else {
    const title = m.year ? `${m.title} ${m.year}` : m.title;
    await loadFiles(title, m);
  }
}

// ── TV Series: Show Season Selector ──────────
async function loadTVSeries(info) {
  showScreen('files');

  $('movieHeaderInfo').innerHTML = `
    ${info.poster ? `<img class="movie-thumb" src="${esc(info.poster)}" alt="" onerror="this.style.display='none'">` : ''}
    <div>
      <div class="movie-header-title">${esc(info.title)}</div>
      ${info.year ? `<div class="movie-header-sub">📅 ${info.year} · 📺 TV Series</div>` : ''}
    </div>`;

  $('filesList').innerHTML = '';
  $('filesLoading').classList.add('visible');

  try {
    const res  = await fetch(`/api/seasons?title=${encodeURIComponent(info.title)}`);
    const data = await res.json();
    $('filesLoading').classList.remove('visible');

    if (!data.seasons?.length) {
      $('filesList').innerHTML = `<div class="empty-state visible"><div class="empty-icon">😕</div><h3>Seasons nahi mile</h3><p>Ye abhi available nahi hai</p></div>`;
      return;
    }

    state._seasons = data.seasons;
    renderSeasonSelector(info, data.seasons);
  } catch {
    $('filesLoading').classList.remove('visible');
    $('filesList').innerHTML = `<div class="empty-state visible"><div class="empty-icon">😕</div><h3>Error aa gaya</h3><p>Dobara try karo</p></div>`;
  }
}

function renderSeasonSelector(info, seasons) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-season-header">
      <div class="tv-season-label">📺 Season Select Karo</div>
    </div>
    <div class="season-grid" id="seasonGrid"></div>`;

  const grid = $('seasonGrid');
  seasons.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'season-btn';
    btn.style.animationDelay = `${i*0.05}s`;
    btn.innerHTML = `
      <div class="season-btn-icon">📺</div>
      <div class="season-btn-label">Season ${s}</div>`;
    btn.addEventListener('click', () => loadSeasonFiles(info, s));
    grid.appendChild(btn);
  });
}

// ── Load Season Files ─────────────────────────
async function loadSeasonFiles(info, season) {
  state.currentSeason = season;
  const tvPath = `${info.title}/${season}/all`;

  // Show loading
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-season-header">
      <button class="back-season-btn" id="backToSeasons">← Seasons</button>
      <div class="tv-season-label">📺 ${esc(info.title)} — Season ${season}</div>
    </div>`;

  const loading = document.createElement('div');
  loading.className = 'loading-state visible';
  loading.innerHTML = '<div class="spinner-ring"></div><p>Episodes load ho rahe hain... 📁</p>';
  list.appendChild(loading);

  $('backToSeasons').addEventListener('click', () => {
    renderSeasonSelector(info, state._seasons);
  });

  try {
    const res  = await fetch(`/api/files?tvPath=${encodeURIComponent(tvPath)}`);
    const data = await res.json();
    loading.remove();

    if (!data.files?.length) {
      list.insertAdjacentHTML('beforeend', `<div class="empty-state visible"><div class="empty-icon">😕</div><h3>Koi file nahi mili</h3><p>Ye season abhi available nahi hai</p></div>`);
      return;
    }

    state.currentFiles = data.files;
    renderTVFiles(data.files, season, info, list);
  } catch {
    loading.remove();
    list.insertAdjacentHTML('beforeend', `<div class="empty-state visible"><div class="empty-icon">😕</div><h3>Error aa gaya</h3><p>Dobara try karo</p></div>`);
  }
}

function renderTVFiles(files, season, info, listEl) {
  // Check if any file has a real episode number
  const hasEpisodeNumbers = files.some(f => f.episode !== null && f.episode > 0);

  if (hasEpisodeNumbers) {
    // ── Mode A: Group by individual episode ──────────────
    const byEpisode = {};
    files.forEach(f => {
      const ep = f.episode ?? 0;
      if (!byEpisode[ep]) byEpisode[ep] = [];
      byEpisode[ep].push(f);
    });
    const episodes = Object.keys(byEpisode).map(Number).sort((a,b) => a-b);

    if (byEpisode[0]?.length) {
      const section = document.createElement('div');
      section.className = 'ep-section';
      section.innerHTML = `<div class="ep-section-label">📦 Complete Season ${season} Pack</div>`;
      [...byEpisode[0]].sort((a,b) => (b.quality||0)-(a.quality||0)).forEach((f,i) => section.appendChild(makeFileCard(f,i)));
      listEl.appendChild(section);
    }
    episodes.filter(ep => ep > 0).forEach(ep => {
      const section = document.createElement('div');
      section.className = 'ep-section';
      section.innerHTML = `<div class="ep-section-label">🎬 Episode ${ep}</div>`;
      [...byEpisode[ep]].sort((a,b) => (b.quality||0)-(a.quality||0)).forEach((f,i) => section.appendChild(makeFileCard(f,i)));
      listEl.appendChild(section);
    });

  } else {
    // ── Mode B: No episode numbers — detect packs from name/caption ──
    // Parse labels like: "EP 01-05", "EP 06-10", "EP 01 10", "Complete", "Part 1" etc.
    function getPackLabel(f) {
      const src = f.caption || f.name || '';
      // Match "EP 01 05", "EP 01-05", "EP 06 10", "Ep(01-05)" patterns
      const epRange = src.match(/\bEP?\s*[\(\[]?(\d{1,3})[\s\-–_]+(\d{1,3})[\)\]]?/i);
      if (epRange) return `Episodes ${parseInt(epRange[1])}–${parseInt(epRange[2])}`;
      // Single episode reference like "EP 01"
      const epSingle = src.match(/\bEP?\s*[\(\[]?(\d{1,3})[\)\]]?/i);
      if (epSingle) return `Episode ${parseInt(epSingle[1])}`;
      // Part label
      const part = src.match(/\bPart\s*(\d+)\b/i);
      if (part) return `Part ${part[1]}`;
      // Complete / All
      if (/\bComplete\b|\bAll\b/i.test(src)) return `Complete Season ${season}`;
      return `Season ${season} Pack`;
    }

    // Group by detected label
    const byLabel = {};
    files.forEach(f => {
      const label = getPackLabel(f);
      if (!byLabel[label]) byLabel[label] = [];
      byLabel[label].push(f);
    });

    // Sort labels: "Episodes X-Y" by start number, then "Complete", then others
    const sortedLabels = Object.keys(byLabel).sort((a,b) => {
      const getNum = s => { const m = s.match(/(\d+)/); return m ? parseInt(m[1]) : 9999; };
      if (a.startsWith('Complete') || a.startsWith('Season')) return 1;
      if (b.startsWith('Complete') || b.startsWith('Season')) return -1;
      return getNum(a) - getNum(b);
    });

    sortedLabels.forEach(label => {
      const section = document.createElement('div');
      section.className = 'ep-section';
      section.innerHTML = `<div class="ep-section-label">📦 ${label}</div>`;
      [...byLabel[label]].sort((a,b) => (b.quality||0)-(a.quality||0)).forEach((f,i) => section.appendChild(makeFileCard(f,i)));
      listEl.appendChild(section);
    });
  }
}


// ── Files (for movies) ────────────────────────
async function loadFiles(title, info) {
  state.currentMovie = { title, info };
  showScreen('files');

  $('movieHeaderInfo').innerHTML = `
    ${info.poster ? `<img class="movie-thumb" src="${esc(info.poster)}" alt="" onerror="this.style.display='none'">` : ''}
    <div>
      <div class="movie-header-title">${esc(info.title)}</div>
      ${info.year ? `<div class="movie-header-sub">📅 ${info.year} · ${info.mediaType==='tv' ? '📺 TV Series' : '🎬 Movie'}</div>` : ''}
    </div>`;

  $('filesList').innerHTML = '';
  $('filesLoading').classList.add('visible');

  try {
    const res  = await fetch(`/api/files?title=${encodeURIComponent(title)}`);
    const data = await res.json();
    $('filesLoading').classList.remove('visible');
    if (!data.files?.length) {
      $('filesList').innerHTML = `<div class="empty-state visible"><div class="empty-icon">😕</div><h3>Koi file nahi mili</h3><p>Ye abhi available nahi hai</p></div>`;
      return;
    }
    state.currentFiles = data.files;
    renderFiles(data.files);
  } catch { $('filesLoading').classList.remove('visible'); }
}

function makeFileCard(f, i) {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.style.animationDelay = `${i*0.04}s`;
  const isDual = (f.languages||[]).length > 1;
  const langs  = (f.languages||[]).join(' + ') || '—';
  const qual   = f.quality ? `${f.quality}p` : 'HD';
  const size   = fmtSize(f.size);
  card.innerHTML = `
    <div class="file-icon">🎞️</div>
    <div class="file-info">
      <div class="file-name" title="${esc(f.name)}">${esc(f.name)}</div>
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

function renderFiles(files) {
  const list   = $('filesList');
  list.innerHTML = '';
  [...files].sort((a,b) => (b.quality||0)-(a.quality||0)).forEach((f,i) => {
    list.appendChild(makeFileCard(f, i));
  });
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
        <div class="dl-title">${esc(file.name)}</div>
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

        <button class="btn-gen" id="generateBtn">
          ✨ Links Generate Karo
        </button>

        <div class="action-sections" id="actionSections">

          <!-- Download -->
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

          <div class="expire-row">
            ⏱️ <span id="expireText">Links 6 ghante valid hain</span>
          </div>

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

  const token = makeToken(file.fileUniqueId, file.chatId, file.messageId);
  const urls  = buildUrls(token);

  $('actionSections').classList.add('visible');
  $('downloadBtn').href = urls.download;

  $('copyDlBtn').addEventListener('click', () => { copyText(urls.download, 'copyDlBtn'); toast('⬇️ Download link copy ho gaya!'); });

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
    // If we're in an episode view, go back to season selector
    if (state.currentSeason !== null && state.currentMovie?.info?.mediaType === 'tv') {
      loadTVSeries(state.currentMovie.info);
    } else if (state.currentMovie) {
      showScreen('files');
    } else {
      showScreen('results');
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.metaKey||e.ctrlKey) && e.key==='k') {
      e.preventDefault(); showScreen('hero'); setTimeout(() => si.focus(), 100);
    }
  });

  showScreen('hero');
  si.focus();
});
