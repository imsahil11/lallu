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
    uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    localStorage.setItem(KEY, uid);
  }
  return uid;
}

const UID = getUID();

let _clientHints = null;
let _hintsPromise = null;
function fetchClientHints() {
  _hintsPromise = (async () => {
    try {
      if (!navigator.userAgentData) return;
      const h = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'mobile', 'model']);
      _clientHints = { platform: h.platform || null, platformVersion: h.platformVersion || null, mobile: h.mobile ?? false, model: h.model || null };
    } catch {}
  })();
}

function track(action, data = {}) {
  const fire = () => fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, uid: UID, clientHints: _clientHints }),
    keepalive: true,
  }).catch(() => {});
  if (_hintsPromise && !_clientHints) {
    Promise.race([_hintsPromise, new Promise(r => setTimeout(r, 300))]).then(fire);
  } else { fire(); }
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
  query:       '',
  results:     [],
  movie:       null,   // { source: 'filmyfly'|'potterflix', ... }
  // filmyfly specific
  parts:       [],
  activePart:  null,
  activeLink:  null,
  ffPage:      1,
  ffTotalPages: 1,
  // potterflix specific
  pfFiles:     [],
  pfSeason:    null,
};

const SCREENS       = ['hero', 'results', 'files', 'download'];
const SCREEN_DISPLAY = { hero: 'flex', results: 'block', files: 'block', download: 'block' };

let _currentScreen = 'hero';
let _resultsScroll = 0;

function show(name) {
  if (_currentScreen === 'results' && name !== 'results') _resultsScroll = window.scrollY;
  _currentScreen = name;

  SCREENS.forEach(id => {
    const el = $(`s-${id}`);
    if (!el) return;
    el.style.display = id === name ? (SCREEN_DISPLAY[id] || 'block') : 'none';
  });
  const homeBtn = $('navHomeBtn');
  if (homeBtn) homeBtn.style.display = name === 'hero' ? 'none' : 'flex';
  // admin gear only on the homepage — it just overlaps content everywhere else
  const fab = $('adminFab');
  if (fab) fab.style.display = name === 'hero' ? 'flex' : 'none';
  // nav search: visible only on results screen
  const navSearch = $('navSearch');
  if (navSearch) navSearch.style.display = name === 'results' ? 'flex' : 'none';
  if (name === 'results' && S.query) { const nsi = $('navSearchInput'); if (nsi) nsi.value = S.query; }

  // hash routing — browser back button support
  const newHash = name === 'hero' ? '' : name;
  if (location.hash.replace('#', '') !== newHash) {
    if (newHash) location.hash = newHash;
    else history.pushState(null, '', location.pathname + location.search);
  }

  window.scrollTo({ top: name === 'results' ? _resultsScroll : 0, behavior: 'instant' });
}

// 

let _searchCtrl = null;
// chips hint ref — module-level so loadLatestChips (outside DOMContentLoaded) can call it
let updateChipsHint = () => {};

async function doSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  if (_searchCtrl) _searchCtrl.abort();
  _searchCtrl = new AbortController();
  const signal = _searchCtrl.signal;

  S.query = q;
  track('search', { query: q });
  [$('searchInput'), $('navSearchInput'), $('emptySearchInput')].forEach(el => { if (el) el.value = q; });
  _resultsScroll = 0;
  show('results');
  $('resultsQuery').textContent = q;
  const badge = $('resultsCount');
  badge.textContent = '';
  badge.classList.remove('show');

  const grid = $('resultsGrid');
  grid.innerHTML = '';
  hideEl('searchEmpty');
  hideEl('searchLoading'); // spinner hata do — skeleton le lega jagah

  // 6 shimmer skeleton cards turant inject karo
  for (let i = 0; i < 6; i++) {
    const sk = document.createElement('div');
    sk.className = 'card card-skeleton';
    sk.innerHTML = `
      <div class="skel-poster"></div>
      <div class="skel-info">
        <div class="skel-line skel-title"></div>
        <div class="skel-line skel-year"></div>
      </div>`;
    grid.appendChild(sk);
  }

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
        if (S.query !== q) return; // new search started — don't touch its skeletons
        grid.querySelectorAll('.card-skeleton').forEach(el => {
          el.classList.add('skel-removing');
          el.addEventListener('animationend', () => el.remove(), { once: true });
        });
        if (!anyFound) showEl('searchEmpty');
      }
    };

    const processResults = (data, isFF) => {
      if (S.query !== q) { finalize(); return; } // stale response from aborted search
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

        const skels = grid.querySelectorAll('.card-skeleton');
        const frag  = document.createDocumentFragment();
        results.forEach((m, i) => {
          const card = makeCard(m);
          if (skels[i]) {
            grid.replaceChild(card, skels[i]); // skeleton → real card
          } else {
            frag.appendChild(card);
          }
        });
        if (frag.childNodes.length) grid.appendChild(frag);
      }
      finalize();
    };

    fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal })
      .then(r => r.json()).then(d => processResults(d, true)).catch(finalize);

    fetch(`/api/pf/search?q=${encodeURIComponent(q)}`, { signal })
      .then(r => r.json()).then(d => processResults(d, false)).catch(finalize);

  } catch (err) {
    if (err.name === 'AbortError') return;
    grid.querySelectorAll('.card-skeleton').forEach(el => el.remove());
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

function initLoadMore() {
  $('loadMoreBtn').addEventListener('click', async () => {
    if (S.ffPage >= S.ffTotalPages) return;

    // capture query at the moment of click — guards against mid-flight new searches
    const queryAtClick = S.query;
    S.ffPage++;
    const btn = $('loadMoreBtn');
    btn.textContent = 'Loading...';
    btn.disabled = true;

    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(queryAtClick)}&page=${S.ffPage}`);
      const data = await r.json();

      // discard if user started a new search while this was loading
      if (S.query !== queryAtClick) return;

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
      if (S.query !== queryAtClick) return; // new search fired, ignore silently
      btn.textContent = 'Failed. Try again';
      btn.disabled = false;
      S.ffPage--;
    }
  });
}

// 



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

  // one request for movie page + links (was two sequential ones). 20s cap, one automatic retry on
  // network/5xx errors; a 404 means the title genuinely has no links, so that is not retried.
  const retry = () => loadFFMovie(m);
  try {
    let r = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { r = await getJSON(`/api/movie-links?id=${encodeURIComponent(m.id)}`, 20000); } catch { r = null; }
      if (r && (r.ok || r.status === 404 || r.status === 400)) break;
    }
    hideFilesLoading();
    if (!r) { showRetry($('filesList'), 'Connection slow hai', 'Internet check karo ya dobara try karo', retry); return; }
    if (r.status === 404 || r.status === 400) {
      $('filesList').innerHTML = emptyHTML('Link nahi mila', 'Ye title abhi available nahi hai');
      return;
    }
    if (!r.ok || !r.data?.links) { showRetry($('filesList'), 'Links abhi load nahi hue', 'Server busy hai, dobara try karo', retry); return; }

    const mv = r.data.movie || {};
    const lk = r.data.links;
    if (mv.poster && !m.poster) { S.movie = { ...m, poster: mv.poster }; setMovieHead(S.movie); }
    if (!lk.parts?.length) {
      $('filesList').innerHTML = emptyHTML('Download links nahi mile', 'Baad mein try karo');
      return;
    }
    S.parts = lk.parts;
    S.parts.length === 1 ? renderQualities(S.parts[0].links) : renderParts(S.parts);
  } catch {
    hideFilesLoading();
    showRetry($('filesList'), 'Kuch gadbad ho gayi', '', retry);
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
  appendQualityCards(list, links);
}

function renderQualities(links) {
  const list = $('filesList');
  list.innerHTML = '';
  appendQualityCards(list, links);
}

// every quality is listed. cloud ones get fast/cloud buttons; "drive" ones open the FilesDL page
// in the user's own browser (see renderFFServerButtons, reason "external").
function appendQualityCards(list, links) {
  const frag = document.createDocumentFragment();
  // direct (cloud) qualities first, drive (external page) after; original order kept inside each group
  const ordered = [...links.filter(l => l.dltype !== 'drive'), ...links.filter(l => l.dltype === 'drive')];
  ordered.forEach(link => frag.appendChild(makeQualityCard(link)));
  list.appendChild(frag);
  prefetchServers(ordered);   // warm up the first two direct qualities while the user is still choosing
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
      <div class="file-name">${esc(qual)}</div>
      <div class="file-tags">
        <span class="tag tag-s">💾 ${esc(size)}</span>
      </div>
    </div>
    <div class="file-arrow">›</div>`;

  card.addEventListener('click', () => {
    S.activeLink = link;
    track('download_click', { title: S.movie?.title, quality: qual, size, source: 'Server 1' });
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
  // series: say which part this download belongs to (single-part movies have no label)
  const partLabel = (S.parts.length > 1 && S.activePart != null) ? (S.parts[S.activePart]?.label || '') : '';

  $('dlCard').innerHTML = `
    <div class="dl-bar"></div>
    <div class="dl-header">
      ${S.movie?.poster
        ? `<img class="dl-poster" src="${esc(S.movie.poster)}" alt="" onerror="this.outerHTML='<div class=&quot;dl-icon&quot;>🎬</div>'">`
        : '<div class="dl-icon">🎬</div>'}
      <div class="dl-title">${esc(title)}</div>
    </div>
    <div class="dl-meta">
      <div class="dl-meta-item"><span class="dl-meta-emoji">🏆</span><span class="dl-meta-label">Quality</span><span class="dl-meta-val">${esc(qual)}</span></div>
      <div class="dl-meta-item"><span class="dl-meta-emoji">💾</span><span class="dl-meta-label">Size</span><span class="dl-meta-val">${esc(size)}</span></div>
      ${partLabel ? `<div class="dl-meta-item"><span class="dl-meta-emoji">📁</span><span class="dl-meta-label">Part</span><span class="dl-meta-val">${esc(partLabel)}</span></div>` : ''}
    </div>
    <div class="dl-body">
      <div id="ffServersWrap">
        <div class="state-wrap" style="display:flex">
          <div class="spinner"></div>
          <p>Servers dhoondh rahe hain...</p>
        </div>
      </div>
    </div>`;

  // Only real failures (network error, timeout, 5xx) are retried automatically, once. A clean answer of
  // "blocked / not offered / format changed" is final — retrying it just made users wait twice as long.
  const wrap = $('ffServersWrap');
  const myLink = link;
  const fetchServers = async (attempt = 0) => {
    let r = null;
    const pre = attempt === 0 ? PREFETCH.get(myLink.fid) : null;
    if (pre && Date.now() - pre.t < 25_000) r = await pre.p;        // usually already finished
    if (!r || !r.ok || !r.data) {
      PREFETCH.delete(myLink.fid);
      try { r = await getJSON(`/api/servers?dltype=${encodeURIComponent(myLink.dltype)}&fid=${encodeURIComponent(myLink.fid)}`); }
      catch { r = null; }
    }
    if (S.activeLink !== myLink) return;                            // user already went back / picked another one
    if (r && r.ok && r.data) return renderFFServerButtons(r.data, title, qual, size, () => { PREFETCH.delete(myLink.fid); show1(); });
    if (attempt < 1) return fetchServers(1);
    track('server_error', { title, qual, reason: 'timeout' });
    showRetry(wrap, 'Server links nahi mile', 'Connection ya server slow hai', () => { PREFETCH.delete(myLink.fid); show1(); });
  };
  const show1 = () => {
    wrap.innerHTML = `<div class="state-wrap" style="display:flex"><div class="spinner"></div><p>Servers dhoondh rahe hain...</p></div>`;
    const slow = setTimeout(() => { const p = wrap.querySelector('p'); if (p) p.textContent = 'Thoda time lag raha hai, ruko...'; }, 4000);
    fetchServers(0).finally(() => clearTimeout(slow));
  };
  fetchServers(0);
}

function renderFFServerButtons(data, title, qual, size, onRetry) {
  const hasShare = !!navigator.share;
  const wrap = $('ffServersWrap');
  if (!data.fffast && !data.cloud) {
    const msgs = {
      blocked:        'Server abhi busy / blocked hai, thodi der baad dobara try karo',
      not_offered:    'Is quality ke liye Fast/Cloud server nahi hai, dusri quality try karo',
      format_changed: 'Site ka format badal gaya lagta hai, developer ko batao',
    };
    // "blocked" is usually temporary, so offer a manual retry; the others will not change by retrying
    if (data.reason === 'blocked' && onRetry) { track('server_error', { title, qual, reason: 'blocked' }); showRetry(wrap, 'Server abhi busy hai', msgs.blocked, onRetry); return; }
    track('server_error', { title, qual, reason: data.reason || 'no_server' });
    wrap.innerHTML = `<div class="state-wrap" style="display:flex"><div class="state-icon">😕</div><p>${esc(msgs[data.reason] || 'Koi server available nahi hai abhi')}</p></div>`;
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
          <div class="dl-action-sub">⭐ Recommended · Sabse tez</div>
        </div>
        <div class="dl-action-btns">
          <button class="btn-copy" id="copyFf">📋 Copy</button>
          ${hasShare ? '<button class="btn-share" id="shareFf">📤 Share</button>' : ''}
        </div>
      </div>
      <a class="btn-dl" href="${esc(data.fffast)}" target="_blank" rel="noopener noreferrer">⬇️ Download Karo</a>`;
    wrap.appendChild(card);
    card.querySelector('a.btn-dl').addEventListener('click', () => { track('download_start', { title, qual, source: 'Fast' }); }, { passive: true });
    card.querySelector('#copyFf').addEventListener('click', () => {
      navigator.clipboard.writeText(data.fffast).then(() => toast('📋 Fast link copy ho gaya!')).catch(() => {});
      track('link_copy', { title, qual, source: 'Fast' });
    }, { passive: true });
    const sf = card.querySelector('#shareFf');
    if (sf) sf.addEventListener('click', () => { navigator.share({ title, url: data.fffast }).catch(() => {}); track('link_share', { title, qual, source: 'Fast' }); }, { passive: true });
  }

  if (data.cloud) {
    const card2 = document.createElement('div');
    card2.className = 'dl-action-card';
    card2.style.marginTop = data.fffast ? '12px' : '0';
    card2.innerHTML = `
      <div class="dl-action-top">
        <div class="dl-action-ico">☁️</div>
        <div class="dl-action-info">
          <div class="dl-action-title">Cloud Direct</div>
          <div class="dl-action-sub">${data.fffast ? 'CDN server · Direct file' : '⭐ Recommended · Direct CDN'}</div>
        </div>
        <div class="dl-action-btns">
          <button class="btn-copy" id="copyCloud">📋 Copy</button>
          ${hasShare ? '<button class="btn-share" id="shareCloud">📤 Share</button>' : ''}
        </div>
      </div>
      <a class="btn-dl" href="${esc(data.cloud)}" target="_blank" rel="noopener noreferrer">☁️ Cloud Download</a>`;
    wrap.appendChild(card2);
    card2.querySelector('a.btn-dl').addEventListener('click', () => { track('download_start', { title, qual, source: 'Cloud' }); }, { passive: true });
    card2.querySelector('#copyCloud').addEventListener('click', () => {
      navigator.clipboard.writeText(data.cloud).then(() => toast('📋 Cloud link copy ho gaya!')).catch(() => {});
      track('link_copy', { title, qual, source: 'Cloud' });
    }, { passive: true });
    const sc = card2.querySelector('#shareCloud');
    if (sc) sc.addEventListener('click', () => { navigator.share({ title, url: data.cloud }).catch(() => {}); track('link_share', { title, qual, source: 'Cloud' }); }, { passive: true });
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
      const { data: sd } = await getJSON(`/api/pf/seasons?title=${encodeURIComponent(m.title)}`);
      hideFilesLoading();
      if (sd?.poster && !m.poster) { S.movie = { ...m, poster: sd.poster }; setMovieHead(S.movie); }
      if (!sd?.seasons?.length) {
        $('filesList').innerHTML = emptyHTML('Seasons nahi mile', 'Baad mein try karo');
        return;
      }
      renderPFSeasons(sd.seasons, m.title);
    } else {
      // Movie — load files directly
      const { data: fd } = await getJSON(`/api/pf/files?title=${encodeURIComponent(m.title)}`);
      hideFilesLoading();
      if (fd?.poster && !m.poster) { S.movie = { ...m, poster: fd.poster }; setMovieHead(S.movie); }
      S.pfFiles = fd?.files || [];
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
    const { data: ed } = await getJSON(`/api/pf/episodes?title=${encodeURIComponent(title)}&season=${season}`);
    hideFilesLoading();
    if (!ed?.buttons?.length) { $('filesList').innerHTML = emptyHTML('Episodes nahi mile', ''); return; }
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
        const { data: fd } = await getJSON(`/api/pf/files?tvPath=${encodeURIComponent(tvPath)}`).catch(() => ({ data: { files: [] } }));
        hideFilesLoading();
        S.pfFiles = fd?.files || [];
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
    track('download_click', { title: S.movie?.title, quality: qual, source: 'Server 2', season: S.pfSeason });
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
      ${S.movie?.poster
        ? `<img class="dl-poster" src="${esc(S.movie.poster)}" alt="" onerror="this.outerHTML='<div class=&quot;dl-icon&quot;>🎬</div>'">`
        : '<div class="dl-icon">🎬</div>'}
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
  $('dlBtn').addEventListener('click', () => { track('download_start', { title: name, source: 'Server 2' }); }, { passive: true, once: true });

  $('copyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(url).then(() => toast('📋 Link copy ho gaya!')).catch(() => {});
    track('link_copy', { title: name, source: 'Server 2' });
  }, { passive: true, once: true });

  const shareBtn = $('shareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      navigator.share({ title: name || 'Download Link', text: `🎬 ${name} download karo — 6 ghante valid`, url }).catch(() => {});
      track('link_share', { title: name, source: 'Server 2' });
    }, { passive: true, once: true });
  }

  $('dlActions').classList.add('show');
}

//

function emptyHTML(title, sub) {
  return `<div class="state-wrap" style="display:flex">
    <div class="state-icon">😕</div>
    <h3>${esc(title)}</h3>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
  </div>`;
}

// error state with a "try again" button; onRetry runs when it is pressed
function showRetry(container, title, sub, onRetry) {
  container.innerHTML = `<div class="state-wrap" style="display:flex">
    <div class="state-icon">⚠️</div>
    <h3>${esc(title)}</h3>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
    <button class="btn-gen retry-btn" type="button" style="max-width:220px;margin-top:14px">🔄 Dobara try karo</button>
  </div>`;
  container.querySelector('.retry-btn').addEventListener('click', onRetry, { once: true });
}

// fetch JSON with a hard timeout so a stuck request can never leave a spinner running forever.
// resolves { ok, status, data }; rejects only on network error / timeout.
async function getJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    let data = null;
    try { data = await r.json(); } catch { /* non-json body */ }
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}

// links for the first couple of qualities are fetched quietly as soon as the list shows,
// so by the time the user taps one the answer is usually already there (kept in memory ~25s only).
const PREFETCH = new Map();
function prefetchServers(links) {
  links.slice(0, 2).forEach(l => {
    const hit = PREFETCH.get(l.fid);
    if (hit && Date.now() - hit.t < 25_000) return;
    PREFETCH.set(l.fid, {
      t: Date.now(),
      p: getJSON(`/api/servers?dltype=${encodeURIComponent(l.dltype)}&fid=${encodeURIComponent(l.fid)}`).catch(() => null),
    });
  });
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

let _adminPass = '';

function openAdmin() { showEl('adminOverlay', 'flex'); $('adminPassInput').focus(); }
function closeAdmin() {
  hideEl('adminOverlay');
  showEl('adminAuth', 'block');
  hideEl('adminLogs');
  $('adminPassInput').value = '';
  $('adminPassErr').textContent = '';
  if($('adminClearBtn')) $('adminClearBtn').style.display = 'none';
  _adminPass = '';
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
      _adminPass = pass;
      hideEl('adminAuth');
      showEl('adminLogs', 'flex');
      renderAdminLogs(data.logs || [], data.stats || {});
    }
  } catch { $('adminPassErr').textContent = '❌ Server error, try again'; }
  finally { btn.disabled = false; btn.textContent = 'Unlock →'; }
}


async function clearAdminLogs() {
  if (!_adminPass || !confirm('Sach me saare logs delete karne hain?')) return;
  const btn = $('adminClearBtn');
  btn.textContent = 'Clearing...';
  try {
    const res = await fetch('/api/admin/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: _adminPass }) });
    const data = await res.json();
    if (data.ok) await submitAdminPass(); // refresh — renderAdminLogs button chhupa dega
  } catch {}
  btn.textContent = '🗑️ Clear';
}

const ACTION_LABEL = {
  search: '🔍 Search', movie_click: '🎬 Movie Clicked', part_click: '📁 Part Clicked',
  download_click: '⬇️ Download', download_start: '🚀 Download Started',
  link_copy: '📋 Copied', link_share: '📤 Shared', server_error: '❌ Error',
};

function relTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

let _adminTab = 'all';
let _adminLogs = [];

function buildLogEntry(log) {
  const d = log.data || {};
  let detail = '';
  if (d.query) detail = `"${d.query}"`;
  else if (d.title && d.quality) detail = `${d.title} · ${d.quality}`;
  else if (d.title) detail = d.title;
  else if (d.part)  detail = d.part;
  const shortUid = log.uid ? log.uid.substring(0, 8) : null;
  const src = d.source ? ` <span class="admin-log-src">${esc(d.source)}</span>` : '';
  const cls = ['download_click','download_start'].includes(log.action) ? ' entry-download'
             : log.action === 'server_error' ? ' entry-error'
             : ['link_copy','link_share'].includes(log.action) ? ' entry-copy' : '';
  const entry = document.createElement('div');
  entry.className = `admin-log-entry${cls}`;
  entry.innerHTML = `
    <div class="admin-log-row1">
      <span class="admin-log-device">📱 ${esc(log.device || 'Unknown')}</span>
      <span class="admin-log-time">${relTime(log.ts)}</span>
    </div>
    <div class="admin-log-action">${ACTION_LABEL[log.action] || log.action}${detail ? ` — <span class="admin-log-movie">${esc(detail)}</span>` : ''}${src}</div>
    <div class="admin-log-meta">${esc(log.os)} · ${esc(log.browser)}</div>
    ${shortUid ? `<span class="admin-log-uid">uid: ${esc(shortUid)}</span>` : ''}`;
  return entry;
}

function renderFilteredLogs() {
  const listEl = $('adminLogList');
  const filtered = _adminTab === 'downloads' ? _adminLogs.filter(l => ['download_click','download_start'].includes(l.action))
                 : _adminTab === 'errors'    ? _adminLogs.filter(l => l.action === 'server_error')
                 : _adminTab === 'copies'    ? _adminLogs.filter(l => ['link_copy','link_share'].includes(l.action))
                 : _adminLogs;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="admin-empty">📭 ${_adminTab === 'all' ? 'Abhi tak koi activity nahi' : 'Is filter mein kuch nahi'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  filtered.forEach(log => frag.appendChild(buildLogEntry(log)));
  listEl.innerHTML = '';
  listEl.appendChild(frag);
}

function renderAdminLogs(logs, stats) {
  _adminLogs = logs;
  const statsEl  = $('adminStats');
  const listEl   = $('adminLogList');
  const clearBtn = $('adminClearBtn');

  if (clearBtn) clearBtn.style.display = logs.length ? 'block' : 'none';

  const downloads = logs.filter(l => ['download_click','download_start'].includes(l.action)).length;
  const errors    = logs.filter(l => l.action === 'server_error').length;
  const uids      = new Set(logs.map(l => l.uid).filter(Boolean)).size;

  statsEl.innerHTML = `
    <div class="admin-stat"><span class="admin-stat-n">${logs.length}</span><span class="admin-stat-l">Events</span></div>
    <div class="admin-stat"><span class="admin-stat-n">${uids || stats.uniqueUsers || 0}</span><span class="admin-stat-l">Friends</span></div>
    <div class="admin-stat"><span class="admin-stat-n">${downloads}</span><span class="admin-stat-l">Downloads</span></div>
    <div class="admin-stat"><span class="admin-stat-n">${errors}</span><span class="admin-stat-l">Errors</span></div>`;

  if (!$('adminTabs')) {
    const tabsEl = document.createElement('div');
    tabsEl.id = 'adminTabs';
    tabsEl.className = 'admin-tabs';
    tabsEl.innerHTML = `
      <button class="admin-tab active" data-tab="all">All</button>
      <button class="admin-tab" data-tab="downloads">⬇️</button>
      <button class="admin-tab" data-tab="errors">❌${errors ? ` ${errors}` : ''}</button>
      <button class="admin-tab" data-tab="copies">📋</button>`;
    listEl.parentNode.insertBefore(tabsEl, listEl);
    tabsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      _adminTab = btn.dataset.tab;
      tabsEl.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === _adminTab));
      renderFilteredLogs();
    });
  } else {
    const tabsEl = $('adminTabs');
    tabsEl.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === _adminTab));
    const errBtn = tabsEl.querySelector('[data-tab="errors"]');
    if (errBtn) errBtn.textContent = `❌${errors ? ` ${errors}` : ''}`;
  }

  renderFilteredLogs();
}


// 

document.addEventListener('DOMContentLoaded', () => {
  fetchClientHints();

  const si = $('searchInput');
  const sb = $('searchBtn');

  si.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(si.value); });
  sb.addEventListener('click', () => doSearch(si.value), { passive: true });
  initLoadMore();

  // Chips scroll hint — sirf tab dikhao jab overflow ho
  const chipsEl = $('trendingChips');
  const hintEl  = document.getElementById('chipsScrollHint');
  updateChipsHint = function() {
    if (!chipsEl || !hintEl) return;
    const hasOverflow = chipsEl.scrollHeight > chipsEl.clientHeight + 4;
    const atBottom    = chipsEl.scrollHeight - chipsEl.scrollTop <= chipsEl.clientHeight + 4;
    hintEl.classList.toggle('hidden', !hasOverflow || atBottom);
  };
  if (chipsEl) {
    chipsEl.addEventListener('scroll', updateChipsHint, { passive: true });
    // loadLatestChips ke baad bhi re-check karo
    setTimeout(updateChipsHint, 1200);
  }

  // Event delegation — hardcoded + dynamic chips dono handle karta hai
  $('trendingChips')?.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const q = chip.dataset.query || chip.textContent.trim();
    si.value = q;
    doSearch(q);
  }, { passive: true });

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

  // hashchange — browser back button support
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '') || 'hero';
    if (SCREENS.includes(name) && name !== _currentScreen) show(name);
  });

  // nav search (visible on results screen)
  $('navSearchInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { doSearch($('navSearchInput').value); $('navSearchInput').blur(); }
  });

  // empty state re-search
  $('emptySearchBtn')?.addEventListener('click', () => doSearch($('emptySearchInput').value), { passive: true });
  $('emptySearchInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch($('emptySearchInput').value);
  });

  // clean any stale hash on fresh load — always start at hero
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  show('hero');
  // Mobile pe keyboard auto-open nahi — sirf desktop pe focus
  if (!('ontouchstart' in window)) si.focus();
  loadLatestChips();
});

// ── Latest chips for trending section ────────────────
function loadLatestChips() {
  fetch('/api/latest', { signal: AbortSignal.timeout(8000) })
    .then(r => r.json())
    .then(data => {
      const items = data.items || [];
      if (!items.length) return;
      const wrap = $('trendingChips');
      if (!wrap) return;
      const frag = document.createDocumentFragment();
      items.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'chip';
        btn.setAttribute('role', 'listitem');
        btn.textContent = item.title;
        frag.appendChild(btn);
      });
      wrap.appendChild(frag);
      const outer = $('chipsOuter');
      if (outer) outer.hidden = false;
      updateChipsHint();
    })
    .catch(() => {});
}

