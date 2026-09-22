'use strict';

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtSize(b) {
  if (!b || b === 0) return '—';
  if (typeof b === 'string') return b;
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`;
}

function toast(msg) {
  const el = $('toast');
  $('toastMsg').textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function showEl(id, display = 'flex') { const el = $(id); if (el) el.style.display = display; }
function hideEl(id)                   { const el = $(id); if (el) el.style.display = 'none'; }

function getUID() {
  const KEY = 'lallu_uid';
  let uid = localStorage.getItem(KEY);
  if (!uid) {
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

let _clientHints = null;
async function fetchClientHints() {
  try {
    if (!navigator.userAgentData) return null;
    const h = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'mobile', 'model']);
    _clientHints = { platform: h.platform || null, platformVersion: h.platformVersion || null, mobile: h.mobile ?? false, model: h.model || null };
    return _clientHints;
  } catch { return null; }
}

function track(action, data = {}) {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, uid: UID, clientHints: _clientHints }),
    keepalive: true,
  }).catch(() => {});
}

// token logic for pf worker
function b64url(bytes) {
  let s = '';
  bytes.forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeToken(fileUniqueId, chatId, messageId) {
  const exp = Math.floor(Date.now() / 1000) + 21600;  // 6h expiry
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

// app state
const S = {
  query:      '',
  results:    [],
  movie:      null,   // { source: 'filmyfly'|'potterflix', ... }
  // filmyfly specific
  parts:      [],
  activePart: null,
  activeLink: null,
  // potterflix specific
  pfFiles:    [],
  pfSeason:   null,
};

const SCREENS       = ['hero', 'results', 'files', 'download'];
const SCREEN_DISPLAY = { hero: 'flex', results: 'block', files: 'block', download: 'block' };

function show(name) {
  SCREENS.forEach(id => {
    const el = $(`s-${id}`);
    if (!el) return;
    el.style.display = id === name ? (SCREEN_DISPLAY[id] || 'block') : 'none';
  });
  const homeBtn = $('navHomeBtn');
  if (homeBtn) homeBtn.style.display = name === 'hero' ? 'none' : 'flex';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// 

let _searchCtrl = null;

async function doSearch(q) {
  q = (q || '').trim();
  if (!q) return;
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
    S.results = [];
    S.ffPage = 1;
    S.ffTotalPages = 1;
    hideEl('loadMoreWrap');
    let pending = 2;
    let anyFound = false;

    const finalize = () => {
      pending--;
      if (pending === 0) {
        hideEl('searchLoading');
        if (!anyFound) showEl('searchEmpty');
      }
    };

    const processResults = (data, isFF) => {
      const results = data.results || [];
      if (isFF) {
        S.ffTotalPages = data.pages || 1;
        toggleLoadMoreBtn();
      }

      if (results.length > 0) {
        anyFound = true;
        hideEl('searchEmpty');
        S.results.push(...results);
        badge.textContent = `${S.results.length} mili 🎉`;
        badge.classList.add('show');
        
        const frag = document.createDocumentFragment();
        results.forEach(m => frag.appendChild(makeCard(m)));
        $('resultsGrid').appendChild(frag);
      }
      finalize();
    };

    fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal })
      .then(r => r.json()).then(d => processResults(d, true)).catch(finalize);
      
    fetch(`/api/pf/search?q=${encodeURIComponent(q)}`, { signal })
      .then(r => r.json()).then(d => processResults(d, false)).catch(finalize);

  } catch (err) {
    if (err.name === 'AbortError') return;
    hideEl('searchLoading');
    showEl('searchEmpty');
    hideEl('loadMoreWrap');
  }
}

function toggleLoadMoreBtn() {
  if (S.ffPage < S.ffTotalPages) {
    showEl('loadMoreWrap');
    $('loadMoreBtn').textContent = 'Load More';
    $('loadMoreBtn').disabled = false;
  } else {
    hideEl('loadMoreWrap');
  }
}

$('loadMoreBtn').addEventListener('click', async () => {
  if (S.ffPage >= S.ffTotalPages) return;
  S.ffPage++;
  const btn = $('loadMoreBtn');
  btn.textContent = 'Loading...';
  btn.disabled = true;

  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(S.query)}&page=${S.ffPage}`);
    const data = await r.json();
    const results = data.results || [];
    if (results.length > 0) {
      S.results.push(...results);
      $('resultsCount').textContent = `${S.results.length} mili 🎉`;
      const frag = document.createDocumentFragment();
      results.forEach(m => frag.appendChild(makeCard(m)));
      $('resultsGrid').appendChild(frag);
    }
    toggleLoadMoreBtn();
  } catch (e) {
    btn.textContent = 'Failed. Try again';
    btn.disabled = false;
    S.ffPage--; // rollback
  }
});

// 

function renderCards(list) {
  const grid = $('resultsGrid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.forEach(m => frag.appendChild(makeCard(m)));
  grid.appendChild(frag);
}

function makeCard(m) {
  const isPF     = m.source === 'potterflix';
  const isTV     = isPF ? m.mediaType === 'tv' : /web series|series/i.test(m.category || '');
  const badgeTxt = isPF ? 'Server 2' : 'Server 1';
  const badgeCls = isPF ? 'badge-s2'  : 'badge-s1';
  const r        = parseFloat(m.rating || 0);

  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'listitem');
  card.innerHTML = `
    <div class="card-poster">
      ${m.poster
        ? `<img src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy" decoding="async"
             sizes="(max-width:480px) 30vw,(max-width:640px) 22vw,155px"
             class="loading" onload="this.classList.remove('loading')"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-no-poster',textContent:'🎬'}))">`
        : `<div class="card-no-poster">🎬</div>`}
      ${r > 0 ? `<div class="card-rating">⭐ ${r.toFixed(1)}</div>` : ''}
      <div class="card-type ${isTV ? 'type-tv' : 'type-movie'}">${isTV ? 'TV' : 'Film'}</div>
      <div class="card-server ${badgeCls}">${badgeTxt}</div>
    </div>
    <div class="card-info">
      <div class="card-title">${esc(m.title)}</div>
      <div class="card-year">${esc(isPF ? (m.year || '') : (m.category || ''))}</div>
    </div>`;

  card.addEventListener('click', () => onMovieClick(m), { passive: true });
  return card;
}


// 

function onMovieClick(m) {
  S.movie = m;
  track('movie_click', { title: m.title, source: m.source || 'filmyfly' });
  if (m.source === 'potterflix') {
    loadPFMovie(m);
  } else {
    loadFFMovie(m);
  }
}

// 

async function loadFFMovie(m) {
  S.parts      = [];
  S.activePart = null;
  S.activeLink = null;
  show('files');
  setMovieHead(m);
  setFilesLoading('Links dhoondh rahe hain... 🔍');

  try {
    const mv = await fetch(`/api/movie?id=${encodeURIComponent(m.id)}&slug=${encodeURIComponent(m.slug)}`).then(r => r.json());
    if (mv.error || !mv.linkmakeId) {
      $('filesList').innerHTML = emptyHTML('Link nahi mila', 'Ye title abhi available nahi hai');
      hideFilesLoading(); return;
    }
    if (mv.poster && !m.poster) { S.movie = { ...m, poster: mv.poster }; setMovieHead(S.movie); }
    $('filesLoadingMsg').textContent = 'Quality options aa rahe hain... 📦';

    const lk = await fetch(`/api/links?lmId=${encodeURIComponent(mv.linkmakeId)}`).then(r => r.json());
    hideFilesLoading();
    if (lk.error || !lk.parts?.length) {
      $('filesList').innerHTML = emptyHTML('Download links nahi mile', 'Baad mein try karo');
      return;
    }
    S.parts = lk.parts;
    S.parts.length === 1 ? renderQualities(S.parts[0].links) : renderParts(S.parts);
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Kuch gadbad ho gayi', 'Dobara try karo');
  }
}

function renderParts(parts) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-head"><div class="tv-head-title">📦 Part Select Karo</div></div>
    <div class="tv-grid" id="partsGrid"></div>`;
  const grid = $('partsGrid');
  parts.forEach((part, idx) => {
    const btn = document.createElement('button');
    btn.className = 'tv-btn';
    btn.innerHTML = `<div class="tv-btn-ico">📁</div><div class="tv-btn-lbl">${esc(part.label)}</div>`;
    btn.addEventListener('click', () => {
      S.activePart = idx;
      track('part_click', { title: S.movie?.title, part: part.label });
      renderQualitiesWithBack(part.links, part.label);
    }, { passive: true });
    grid.appendChild(btn);
  });
}

function renderQualitiesWithBack(links, partLabel) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-head">
      <button class="tv-back" id="backToParts">← Parts</button>
      <div class="tv-head-title">${esc(partLabel)}</div>
    </div>`;
  $('backToParts').addEventListener('click', () => { S.activePart = null; renderParts(S.parts); }, { passive: true });
  const frag = document.createDocumentFragment();
  links.forEach(link => frag.appendChild(makeQualityCard(link)));
  list.appendChild(frag);
}

function renderQualities(links) {
  const list = $('filesList');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  links.forEach(link => frag.appendChild(makeQualityCard(link)));
  list.appendChild(frag);
}

// filmyfly cards (filename nahi hota isliye quality dikhao)
function makeQualityCard(link) {
  const card = document.createElement('div');
  card.className = 'file-card';
  const qual = link.quality || 'HD';
  const size = link.size   || '—';

  card.innerHTML = `
    <div class="file-ico">🎞️</div>
    <div class="file-meta">
      <div class="file-name">${esc(qual)} · ${esc(size)}</div>
      <div class="file-tags">
        <span class="tag tag-q">🏆 ${esc(qual)}</span>
        <span class="tag tag-s">💾 ${esc(size)}</span>
      </div>
    </div>
    <div class="file-arrow">›</div>`;

  card.addEventListener('click', () => {
    S.activeLink = link;
    track('download_click', { title: S.movie?.title, quality: qual, size });
    openFFDownload(link);
  }, { passive: true });
  return card;
}


// filmyfly download page
function openFFDownload(link) {
  show('download');
  const qual  = link.quality || 'HD';
  const size  = link.size   || '—';
  const title = S.movie?.title || '';

  $('dlCard').innerHTML = `
    <div class="dl-bar"></div>
    <div class="dl-header">
      <div class="dl-icon">🎬</div>
      <div class="dl-title">${esc(title)}</div>
    </div>
    <div class="dl-meta">
      <div class="dl-meta-item"><span class="dl-meta-emoji">🏆</span><span class="dl-meta-label">Quality</span><span class="dl-meta-val">${esc(qual)}</span></div>
      <div class="dl-meta-item"><span class="dl-meta-emoji">💾</span><span class="dl-meta-label">Size</span><span class="dl-meta-val">${esc(size)}</span></div>
    </div>
    <div class="dl-body">
      <div class="dl-pill">
        <span class="dl-pill-ico">⚡</span>
        <span>Server link fetch ho raha hai — seedha download milega 🚀</span>
      </div>
      <div id="ffServersWrap">
        <div class="state-wrap" style="display:flex">
          <div class="spinner"></div>
          <p>Servers dhoondh rahe hain...</p>
        </div>
      </div>
    </div>`;

  const fetchServers = (retry = 1) => {
    fetch(`/api/servers?dltype=${encodeURIComponent(link.dltype)}&fid=${encodeURIComponent(link.fid)}`)
      .then(r => r.json())
      .then(data => {
        if (!data.cloud && !data.fffast && retry > 0) {
          return fetchServers(retry - 1);
        }
        renderFFServerButtons(data, title, qual, size);
      })
      .catch(() => {
        if (retry > 0) return fetchServers(retry - 1);
        $('ffServersWrap').innerHTML = `<div class="state-wrap" style="display:flex"><div class="state-icon">⚠️</div><p>Server links nahi mile, baad mein try karo</p></div>`;
      });
  };
  fetchServers(1);
}

function renderFFServerButtons(data, title, qual, size) {
  const hasShare = !!navigator.share;
  const wrap = $('ffServersWrap');
  if (!data.fffast && !data.cloud) {
    wrap.innerHTML = `<div class="state-wrap" style="display:flex"><div class="state-icon">😕</div><p>Koi server available nahi hai abhi</p></div>`;
    return;
  }
  wrap.innerHTML = '';

  if (data.fffast) {
    const card = document.createElement('div');
    card.className = 'dl-action-card';
    card.innerHTML = `
      <div class="dl-action-top">
        <div class="dl-action-ico">⚡</div>
        <div class="dl-action-info">
          <div class="dl-action-title">10Gbps Fast Download</div>
          <div class="dl-action-sub">Google Drive backed · Max speed</div>
        </div>
        <div class="dl-action-btns">
          <button class="btn-copy" id="copyFf">📋 Copy</button>
          ${hasShare ? '<button class="btn-share" id="shareFf">📤 Share</button>' : ''}
        </div>
      </div>
      <a class="btn-dl" href="${esc(data.fffast)}" target="_blank" rel="noopener noreferrer">⬇️ Download Karo</a>`;
    wrap.appendChild(card);
    card.querySelector('#copyFf').addEventListener('click', () => {
      navigator.clipboard.writeText(data.fffast).then(() => toast('📋 Fast link copy ho gaya!')).catch(() => {});
    }, { passive: true });
    const sf = card.querySelector('#shareFf');
    if (sf) sf.addEventListener('click', () => { navigator.share({ title, url: data.fffast }).catch(() => {}); }, { passive: true });
  }

  if (data.cloud) {
    const card2 = document.createElement('div');
    card2.className = 'dl-action-card';
    card2.style.marginTop = '12px';
    card2.innerHTML = `
      <div class="dl-action-top">
        <div class="dl-action-ico">☁️</div>
        <div class="dl-action-info">
          <div class="dl-action-title">Cloud Direct</div>
          <div class="dl-action-sub">CDN server · Direct file</div>
        </div>
        <div class="dl-action-btns">
          <button class="btn-copy" id="copyCloud">📋 Copy</button>
          ${hasShare ? '<button class="btn-share" id="shareCloud">📤 Share</button>' : ''}
        </div>
      </div>
      <a class="btn-dl" href="${esc(data.cloud)}" target="_blank" rel="noopener noreferrer">☁️ Cloud Download</a>`;
    wrap.appendChild(card2);
    card2.querySelector('#copyCloud').addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.origin + data.cloud).then(() => toast('📋 Cloud link copy ho gaya!')).catch(() => {});
    }, { passive: true });
    const sc = card2.querySelector('#shareCloud');
    if (sc) sc.addEventListener('click', () => { navigator.share({ title, url: window.location.origin + data.cloud }).catch(() => {}); }, { passive: true });
  }
}


// 

async function loadPFMovie(m) {
  S.pfFiles  = [];
  S.pfSeason = null;
  show('files');
  setMovieHead(m);
  setFilesLoading('Files dhoondh rahe hain... 🔍');

  try {
    if (m.mediaType === 'tv') {
      // TV — load seasons first
      const sd = await fetch(`/api/pf/seasons?title=${encodeURIComponent(m.title)}`).then(r => r.json());
      hideFilesLoading();
      if (sd.poster && !m.poster) { S.movie = { ...m, poster: sd.poster }; setMovieHead(S.movie); }
      if (!sd.seasons?.length) {
        $('filesList').innerHTML = emptyHTML('Seasons nahi mile', 'Baad mein try karo');
        return;
      }
      renderPFSeasons(sd.seasons, m.title);
    } else {
      // Movie — load files directly
      const fd = await fetch(`/api/pf/files?title=${encodeURIComponent(m.title)}`).then(r => r.json());
      hideFilesLoading();
      if (fd.poster && !m.poster) { S.movie = { ...m, poster: fd.poster }; setMovieHead(S.movie); }
      S.pfFiles = fd.files || [];
      renderPFFiles(S.pfFiles);
    }
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Kuch gadbad ho gayi', 'Dobara try karo');
  }
}

function renderPFSeasons(seasons, title) {
  const list = $('filesList');
  list.innerHTML = `<div class="tv-head"><div class="tv-head-title">📺 Season Select Karo</div></div><div class="tv-grid" id="seasonsGrid"></div>`;
  const grid = $('seasonsGrid');
  seasons.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'tv-btn';
    btn.innerHTML = `<div class="tv-btn-ico">📺</div><div class="tv-btn-lbl">Season ${s}</div>`;
    btn.addEventListener('click', () => loadPFEpisodes(title, s), { passive: true });
    grid.appendChild(btn);
  });
}

async function loadPFEpisodes(title, season) {
  S.pfSeason = season;
  setFilesLoading(`Season ${season} ke episodes...`);
  try {
    const ed = await fetch(`/api/pf/episodes?title=${encodeURIComponent(title)}&season=${season}`).then(r => r.json());
    hideFilesLoading();
    if (!ed.buttons?.length) { $('filesList').innerHTML = emptyHTML('Episodes nahi mile', ''); return; }
    const list = $('filesList');
    list.innerHTML = `
      <div class="tv-head">
        <button class="tv-back" id="backToSeasons">← Seasons</button>
        <div class="tv-head-title">Season ${season}</div>
      </div>
      <div class="tv-grid" id="epsGrid"></div>`;
    $('backToSeasons').addEventListener('click', () => { S.pfSeason = null; loadPFMovie(S.movie); }, { passive: true });
    const grid = $('epsGrid');
    ed.buttons.forEach(ep => {
      const btn = document.createElement('button');
      btn.className = `tv-btn${ep.isComplete ? ' tv-btn-complete' : ''}`;
      btn.innerHTML = `<div class="tv-btn-ico">${ep.isComplete ? '📦' : '▶️'}</div><div class="tv-btn-lbl">${esc(ep.label)}</div>`;
      btn.addEventListener('click', async () => {
        setFilesLoading('Files load ho rahi hain...');
        const tvPath = ep.path.replace(/^\//, '').split('/').map(decodeURIComponent).join('/');
        const fd = await fetch(`/api/pf/files?tvPath=${encodeURIComponent(tvPath)}`).then(r => r.json()).catch(() => ({ files: [] }));
        hideFilesLoading();
        S.pfFiles = fd.files || [];
        renderPFFilesWithBack(S.pfFiles, title, season);
      }, { passive: true });
      grid.appendChild(btn);
    });
  } catch {
    hideFilesLoading();
    $('filesList').innerHTML = emptyHTML('Load nahi hua', 'Dobara try karo');
  }
}

function renderPFFilesWithBack(files, title, season) {
  const list = $('filesList');
  list.innerHTML = `
    <div class="tv-head">
      <button class="tv-back" id="backToEps">← Episodes</button>
    </div>`;
  $('backToEps').addEventListener('click', () => loadPFEpisodes(title, season), { passive: true });
  const wrap = document.createElement('div');
  list.appendChild(wrap);
  renderPFFilesInto(wrap, files);
}

function renderPFFiles(files) {
  const list = $('filesList');
  list.innerHTML = '';
  renderPFFilesInto(list, files);
}

function renderPFFilesInto(container, files) {
  if (!files.length) {
    container.innerHTML = emptyHTML('Koi file nahi mili', '');
    return;
  }
  // sort highest quality first — same as original
  const sorted = [...files].sort((a, b) => (b.quality || 0) - (a.quality || 0));
  const frag   = document.createDocumentFragment();
  sorted.forEach(f => frag.appendChild(makePFFileCard(f)));
  container.appendChild(frag);
}

function makePFFileCard(f) {
  const card   = document.createElement('div');
  card.className = 'file-card';
  const qual   = f.quality ? `${f.quality}p` : 'HD';
  const size   = fmtSize(f.size);
  const langs  = (f.languages || []).join(' + ') || '—';
  const isDual = (f.languages || []).length > 1;
  const name   = f.name || f.caption || '—';

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

  card.addEventListener('click', () => {
    track('download_click', { title: S.movie?.title, quality: qual });
    openPFDownload(f);
  }, { passive: true });
  return card;
}

// pf download logic
function openPFDownload(file) {
  show('download');
  const qual     = file.quality ? `${file.quality}p` : 'HD';
  const size     = fmtSize(file.size);
  const langs    = (file.languages || []).join(' + ') || '—';
  const name     = file.name || file.caption || '—';
  const hasShare = !!navigator.share;

  $('dlCard').innerHTML = `
    <div class="dl-bar"></div>
    <div class="dl-header">
      <div class="dl-icon">🎬</div>
      <div class="dl-title">${esc(name)}</div>
    </div>
    <div class="dl-meta">
      <div class="dl-meta-item"><span class="dl-meta-emoji">🏆</span><span class="dl-meta-label">Quality</span><span class="dl-meta-val">${qual}</span></div>
      <div class="dl-meta-item"><span class="dl-meta-emoji">💾</span><span class="dl-meta-label">Size</span><span class="dl-meta-val">${size}</span></div>
      <div class="dl-meta-item"><span class="dl-meta-emoji">🎧</span><span class="dl-meta-label">Audio</span><span class="dl-meta-val" style="font-size:.7rem">${langs}</span></div>
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
          <a class="btn-dl" id="dlBtn" href="#" target="_blank" rel="noopener noreferrer">⬇️ Download Karo</a>
        </div>
        <div class="expire-row" id="expireRow">Links 6 ghante valid hain ⏱️</div>
      </div>
    </div>`;

  $('genBtn').addEventListener('click', () => generatePFLink(file, name), { once: true });
}

function generatePFLink(file, name) {
  const btn   = $('genBtn');
  btn.disabled = true;
  btn.textContent = '✅ Link Ready!';

  track('download_click', {
    title: file.name || file.caption,
    quality: file.quality,
    size: fmtSize(file.size),
    languages: (file.languages || []).join('+'),
  });

  const token = makeToken(file.fileUniqueId, file.chatId, file.messageId);
  const url   = dlUrl(token);

  $('dlBtn').href = url;

  $('copyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(url).then(() => toast('📋 Link copy ho gaya!')).catch(() => {});
  }, { passive: true });

  const shareBtn = $('shareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      navigator.share({ title: name || 'Download Link', text: `🎬 ${name} download karo — 6 ghante valid`, url }).catch(() => {});
    }, { passive: true });
  }

  $('dlActions').classList.add('show');
  startPFCountdown(file, $('expireRow'), name);
}

function startPFCountdown(file, el, name) {
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
        btn.addEventListener('click', () => generatePFLink(file, name), { once: true });
      }
      return;
    }
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    el.textContent = h > 0
      ? `⏱️ ${h}h ${m}m ${s}s baaki hai`
      : `⏱️ ${m}m ${s}s baaki hai`;
    rafId = requestAnimationFrame(tick);
  }
  tick();
  el._stop = () => cancelAnimationFrame(rafId);
}


// 

function emptyHTML(title, sub) {
  return `<div class="state-wrap" style="display:flex">
    <div class="state-icon">😕</div>
    <h3>${esc(title)}</h3>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
  </div>`;
}

function setMovieHead(info) {
  $('movieHead').innerHTML = `
    ${info.poster ? `<img class="movie-thumb" src="${esc(info.poster)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
    <div>
      <div class="movie-head-title">${esc(info.title)}</div>
      ${info.category ? `<div class="movie-head-sub">📂 ${esc(info.category)}</div>` : info.year ? `<div class="movie-head-sub">📅 ${esc(info.year)}</div>` : ''}
    </div>`;
}

function setFilesLoading(msg) {
  $('filesList').innerHTML = '';
  $('filesLoadingMsg').textContent = msg;
  showEl('filesLoading');
}

function hideFilesLoading() { hideEl('filesLoading'); }

// back from download screen
function handleBackToFiles() {
  // stop countdown if running (PF download screen stores _stop on expireRow)
  const expRow = $('expireRow');
  if (expRow?._stop) { expRow._stop(); expRow._stop = null; }

  show('files');
  if (!S.movie) { show('results'); return; }

  if (S.movie.source === 'potterflix') {
    // re-render whatever was showing
    if (S.pfFiles.length) {
      if (S.pfSeason !== null) {
        renderPFFilesWithBack(S.pfFiles, S.movie.title, S.pfSeason);
      } else {
        renderPFFiles(S.pfFiles);
      }
    } else {
      loadPFMovie(S.movie);
    }
    return;
  }

  // filmyfly
  if (!S.parts.length) { show('results'); return; }
  if (S.parts.length > 1 && S.activePart !== null) {
    renderQualitiesWithBack(S.parts[S.activePart].links, S.parts[S.activePart].label);
  } else if (S.parts.length > 1) {
    renderParts(S.parts);
  } else {
    renderQualities(S.parts[0].links);
  }
}

// 

function openAdmin() { showEl('adminOverlay', 'flex'); $('adminPassInput').focus(); }
function closeAdmin() {
  hideEl('adminOverlay');
  showEl('adminAuth', 'block');
  hideEl('adminLogs');
  $('adminPassInput').value = '';
  $('adminPassErr').textContent = '';
  if($('adminClearBtn')) $('adminClearBtn').style.display = 'none';
}

async function submitAdminPass() {
  const pass = $('adminPassInput').value;
  const btn  = $('adminPassBtn');
  if (!pass) return;
  btn.disabled = true;
  btn.textContent = 'Checking...';
  $('adminPassErr').textContent = '';
  try {
    const res  = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) });
    const data = await res.json();
    if (!data.ok) {
      $('adminPassErr').textContent = '❌ Wrong password';
      $('adminPassInput').value = '';
      $('adminPassInput').focus();
    } else {
      hideEl('adminAuth');
      showEl('adminLogs', 'flex');
      if($('adminClearBtn')) $('adminClearBtn').style.display = 'block';
      renderAdminLogs(data.logs || [], data.stats || {});
    }
  } catch { $('adminPassErr').textContent = '❌ Server error, try again'; }
  finally { btn.disabled = false; btn.textContent = 'Unlock →'; }
}


async function clearAdminLogs() {
  const pass = $('adminPassInput').value;
  if (!pass || !confirm('Sach me saare logs delete karne hain?')) return;
  const btn = $('adminClearBtn');
  btn.textContent = 'Clearing...';
  try {
    const res = await fetch('/api/admin/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) });
    const data = await res.json();
    if (data.ok) await submitAdminPass(); // refresh
  } catch {}
  btn.textContent = '??? Clear';
}

const ACTION_LABEL = { search: '🔍 Search', movie_click: '🎬 Clicked', part_click: '📁 Part', download_click: '⬇️ Download' };

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
  if (!logs.length) { listEl.innerHTML = '<div class="admin-empty">📭 Abhi tak koi activity nahi</div>'; return; }
  const frag = document.createDocumentFragment();
  logs.forEach(log => {
    const d = log.data || {};
    let detail = '';
    if (d.query) detail = `"${d.query}"`;
    else if (d.title && d.quality) detail = `${d.title} · ${d.quality}`;
    else if (d.title) detail = d.title;
    else if (d.part)  detail = d.part;
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

// 

document.addEventListener('DOMContentLoaded', () => {
  fetchClientHints();

  const si = $('searchInput');
  const sb = $('searchBtn');

  si.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(si.value); });
  sb.addEventListener('click', () => doSearch(si.value), { passive: true });

  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => { si.value = c.dataset.query; doSearch(c.dataset.query); }, { passive: true });
  });

  $('navLogo')?.addEventListener('click', () => { show('hero'); setTimeout(() => si.focus(), 60); }, { passive: true });
  $('navHomeBtn')?.addEventListener('click', () => { show('hero'); setTimeout(() => si.focus(), 60); }, { passive: true });

  $('backToHero')?.addEventListener('click', () => show('hero'), { passive: true });
  $('backToResults')?.addEventListener('click', () => show('results'), { passive: true });
  $('backToFiles')?.addEventListener('click', handleBackToFiles, { passive: true });

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); show('hero'); setTimeout(() => si.focus(), 80); }
    if (e.key === 'Escape') closeAdmin();
  });

  $('adminFab')?.addEventListener('click', openAdmin, { passive: true });
  $('adminClose')?.addEventListener('click', closeAdmin, { passive: true });
  $('adminPassBtn')?.addEventListener('click', submitAdminPass, { passive: true });
  $('adminClearBtn')?.addEventListener('click', clearAdminLogs, { passive: true });
  $('adminPassInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitAdminPass(); });
  $('adminOverlay')?.addEventListener('click', e => { if (e.target === $('adminOverlay')) closeAdmin(); }, { passive: true });

  show('hero');
  si.focus();
});
