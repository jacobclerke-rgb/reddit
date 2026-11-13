'use strict';

/* =====================================================================
   Broadsheet - a full-screen Reddit reader for iPad.
   Plain JS, no build step. Data comes from Reddit's public JSON
   endpoints, or from oauth.reddit.com when a client ID is configured.
   ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const app = $('#app');
const feedEl = $('#feed');
const detailEl = $('#detail');

/* ---------------------------------------------------------------------
   Persistent settings
   --------------------------------------------------------------------- */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('bs.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('bs.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const DEFAULT_FAVORITES = ['pics', 'worldnews', 'technology', 'science', 'AskReddit', 'apple', 'ipad', 'EarthPorn', 'todayilearned', 'movies'];

const settings = Object.assign({
  theme: 'auto',
  textSize: '17',
  showNsfw: false,
  autoplay: false,
  clientId: '',
  layout: 'split',
  feedWidth: 440,
}, store.get('settings', {}));

let favorites = store.get('favorites', DEFAULT_FAVORITES);
const visited = new Set(store.get('visited', []));

function saveSettings() { store.set('settings', settings); }
function saveFavorites() { store.set('favorites', favorites); }
function markVisited(id) {
  visited.add(id);
  const arr = Array.from(visited);
  store.set('visited', arr.slice(-1500));
}

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  root.style.setProperty('--text', settings.textSize + 'px');
  root.style.setProperty('--feed-w', settings.feedWidth + 'px');
  app.classList.toggle('layout-gallery', settings.layout === 'gallery');
  app.classList.toggle('layout-split', settings.layout !== 'gallery');
}

/* ---------------------------------------------------------------------
   Reddit API
   --------------------------------------------------------------------- */
let tokenCache = store.get('token', null);

function deviceId() {
  let id = store.get('deviceId', null);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 30);
    store.set('deviceId', id);
  }
  return id;
}

async function getToken() {
  if (!settings.clientId) return null;
  if (tokenCache && tokenCache.clientId === settings.clientId && tokenCache.expires > Date.now() + 60000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'https://oauth.reddit.com/grants/installed_client',
    device_id: deviceId(),
  });
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(settings.clientId + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new ApiError('Token request failed (' + res.status + '). Check the client ID in Settings.', res.status);
  const json = await res.json();
  if (!json.access_token) throw new ApiError('Reddit did not return an access token. Check the client ID in Settings.', 0);
  tokenCache = { token: json.access_token, expires: Date.now() + json.expires_in * 1000, clientId: settings.clientId };
  store.set('token', tokenCache);
  return tokenCache.token;
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, params = {}, { signal } = {}) {
  const qs = new URLSearchParams({ raw_json: '1', ...params });
  let token = null;
  try { token = await getToken(); } catch (e) { if (settings.clientId) throw e; }
  const clean = path.replace(/\/+$/, '') || '';
  const url = token
    ? `https://oauth.reddit.com${clean || '/'}?${qs}`
    : `https://www.reddit.com${clean}.json?${qs}`;
  let res;
  try {
    res = await fetch(url, { signal, headers: token ? { Authorization: 'Bearer ' + token } : {} });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Could not reach Reddit. You may be offline, or Reddit is blocking anonymous requests from this network.', 0);
  }
  if (res.status === 401 && token) {
    tokenCache = null; store.set('token', null);
  }
  if (!res.ok) {
    const msg = {
      403: 'Reddit refused the request (403). The subreddit may be private or quarantined, or anonymous access is blocked.',
      404: 'Not found.',
      429: 'Rate limited by Reddit. Wait a moment and refresh.',
    }[res.status] || `Reddit returned an error (${res.status}).`;
    throw new ApiError(msg, res.status);
  }
  return res.json();
}

/* ---------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}
function fmtNum(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  if (Math.abs(n) >= 1e4) return Math.round(n / 1e3) + 'k';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function timeAgo(utc) {
  const s = Math.max(0, Date.now() / 1000 - utc);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd';
  if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + 'mo';
  return Math.floor(s / (86400 * 365)) + 'y';
}
function unescUrl(u) { return u ? u.replace(/&amp;/g, '&') : u; }

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

const ICON_UP = '<svg viewBox="0 0 24 24"><path d="M12 4 4 13h5v7h6v-7h5l-8-9Z"/></svg>';
const ICON_COMMENT = '<svg viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1Zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1Z"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1ZM8 13h8v-2H8v2Zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 0-10Z"/></svg>';
const ICON_TEXT = '<svg viewBox="0 0 24 24"><path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h10v2H4v-2Z"/></svg>';

/* ---------------------------------------------------------------------
   HTML sanitizing for Reddit-rendered markdown
   --------------------------------------------------------------------- */
const ALLOWED_TAGS = new Set(['A', 'P', 'BR', 'HR', 'EM', 'STRONG', 'B', 'I', 'DEL', 'S', 'SUP', 'SUB', 'CODE', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'DIV', 'IMG', 'FIGURE', 'FIGCAPTION']);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'align', 'width', 'height']);

function sanitize(html) {
  if (!html) return '';
  if (html.startsWith('&lt;')) html = decodeEntities(html);
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const root = doc.body.firstChild;
  (function walk(node) {
    for (const child of Array.from(node.children)) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM'].includes(child.tagName)) { child.remove(); continue; }
        child.replaceWith(...child.childNodes);
        walk(node);
        return;
      }
      for (const attr of Array.from(child.attributes)) {
        if (!ALLOWED_ATTRS.has(attr.name)) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') {
        const href = child.getAttribute('href') || '';
        if (/^\s*(javascript|data|vbscript):/i.test(href)) child.removeAttribute('href');
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      if (child.tagName === 'IMG') {
        const src = child.getAttribute('src') || '';
        if (!/^https:\/\//i.test(src)) child.remove();
        else child.setAttribute('loading', 'lazy');
      }
      walk(child);
    }
  })(root);
  return root.innerHTML;
}

/* ---------------------------------------------------------------------
   Post media extraction
   --------------------------------------------------------------------- */
function bestPreview(post, targetWidth = 640) {
  const img = post.preview?.images?.[0];
  if (!img) return null;
  const list = [...(img.resolutions || []), img.source].filter(Boolean);
  const pick = list.find(r => r.width >= targetWidth) || img.source || list[list.length - 1];
  return pick ? { url: unescUrl(pick.url), width: pick.width, height: pick.height } : null;
}

function thumbFor(post) {
  if (post.is_gallery && post.media_metadata && post.gallery_data?.items?.length) {
    const first = post.media_metadata[post.gallery_data.items[0].media_id];
    const p = first?.p?.find(x => x.x >= 320) || first?.p?.[first.p.length - 1] || first?.s;
    if (p?.u) return unescUrl(p.u);
  }
  const prev = bestPreview(post, 320);
  if (prev) return prev.url;
  if (post.thumbnail && /^https?:/.test(post.thumbnail)) return unescUrl(post.thumbnail);
  return null;
}

function redditVideo(post) {
  const src = post.crosspost_parent_list?.[0] || post;
  return src.media?.reddit_video || src.secure_media?.reddit_video || src.preview?.reddit_video_preview || null;
}

function galleryItems(post) {
  const src = post.crosspost_parent_list?.[0]?.is_gallery ? post.crosspost_parent_list[0] : post;
  if (!src.is_gallery || !src.media_metadata || !src.gallery_data) return null;
  const items = [];
  for (const it of src.gallery_data.items) {
    const m = src.media_metadata[it.media_id];
    if (!m || m.status !== 'valid') continue;
    const s = m.s || {};
    const full = unescUrl(s.u || s.gif || '');
    const mp4 = unescUrl(s.mp4 || '');
    const display = m.p?.find(p => p.x >= 1080) || m.p?.[m.p.length - 1];
    items.push({
      full,
      mp4,
      display: display ? unescUrl(display.u) : full,
      width: s.x, height: s.y,
      caption: it.caption || '',
    });
  }
  return items.length ? items : null;
}

function postKind(post) {
  if (galleryItems(post)) return 'gallery';
  if (redditVideo(post)) return 'video';
  const url = post.url_overridden_by_dest || post.url || '';
  if (/\.gifv$/i.test(url) && /imgur\.com/i.test(url)) return 'gifv';
  if (post.post_hint === 'image' || /\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(url)) return 'image';
  if (post.secure_media_embed?.media_domain_url || post.media_embed?.content) return 'embed';
  if (post.is_self) return 'text';
  return 'link';
}

/* ---------------------------------------------------------------------
   Routing: hash is the feed source, e.g. #/r/pics/top?t=week
   --------------------------------------------------------------------- */
const SORTS = ['hot', 'new', 'top', 'rising', 'controversial'];
const TIMES = [['hour', 'Hour'], ['day', 'Today'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['all', 'All time']];

function parseRoute() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  const [pathPart, queryPart] = raw.split('?');
  const q = new URLSearchParams(queryPart || '');
  const parts = pathPart.split('/').filter(Boolean);
  const route = { kind: 'front', sub: null, user: null, sort: 'hot', t: q.get('t') || 'day', q: q.get('q') || '' };
  if (parts[0] === 'r' && parts[1]) {
    route.kind = 'sub';
    route.sub = parts[1];
    if (parts[2] === 'search') route.kind = 'search';
    else if (parts[2] === 'comments' && parts[3]) { route.kind = 'post'; route.postId = parts[3]; route.commentId = parts[5] || null; }
    else if (SORTS.includes(parts[2])) route.sort = parts[2];
  } else if ((parts[0] === 'u' || parts[0] === 'user') && parts[1]) {
    route.kind = 'user';
    route.user = parts[1];
    route.sort = SORTS.includes(parts[2]) ? parts[2] : 'new';
  } else if (parts[0] === 'search') {
    route.kind = 'search';
  } else if (SORTS.includes(parts[0])) {
    route.sort = parts[0];
  }
  if (q.get('sort') && route.kind === 'search') route.sort = q.get('sort');
  return route;
}

function routeToHash(r) {
  let p;
  if (r.kind === 'user') p = `/u/${r.user}/${r.sort}`;
  else if (r.kind === 'search') {
    const qs = new URLSearchParams({ q: r.q, sort: r.sort || 'relevance', t: r.t || 'all' });
    p = (r.sub ? `/r/${r.sub}/search` : '/search') + '?' + qs;
    return '#' + p;
  }
  else if (r.sub) p = `/r/${r.sub}/${r.sort}`;
  else p = `/${r.sort}`;
  if (r.sort === 'top' || r.sort === 'controversial') p += `?t=${r.t}`;
  return '#' + p;
}

function navigate(hash) {
  if (location.hash === hash) loadFeed(true);
  else location.hash = hash;
}

/* ---------------------------------------------------------------------
   Feed
   --------------------------------------------------------------------- */
const feedState = { route: null, after: null, loading: false, done: false, posts: [], seen: new Set(), controller: null, key: '' };
let selectedId = null;

function feedKey(r) { return JSON.stringify([r.kind, r.sub, r.user, r.sort, r.t, r.q]); }

function renderFeedHeader(r) {
  const title = $('#feed-title');
  const sub = $('#feed-sub');
  const fav = $('#btn-fav');
  fav.hidden = !(r.kind === 'sub' && !['all', 'popular'].includes(r.sub.toLowerCase()));
  if (!fav.hidden) fav.classList.toggle('on', favorites.some(f => f.toLowerCase() === r.sub.toLowerCase()));

  if (r.kind === 'front') { title.textContent = 'Home'; sub.textContent = ''; }
  else if (r.kind === 'sub') { title.textContent = 'r/' + r.sub; sub.textContent = ''; }
  else if (r.kind === 'user') { title.textContent = 'u/' + r.user; sub.textContent = ''; }
  else if (r.kind === 'search') { title.textContent = '"' + r.q + '"'; sub.textContent = r.sub ? 'in r/' + r.sub : 'all of Reddit'; }
  document.title = title.textContent + ' - Broadsheet';

  const sorts = $('#sorts');
  const list = r.kind === 'search' ? ['relevance', 'hot', 'top', 'new', 'comments']
    : r.kind === 'user' ? ['new', 'hot', 'top', 'controversial'] : SORTS;
  let html = list.map(s => `<button class="chip ${r.sort === s ? 'on' : ''}" data-sort="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('');
  if (r.sort === 'top' || r.sort === 'controversial' || (r.kind === 'search' && r.sort !== 'new')) {
    html += `<select class="chip chip-select" id="time-select">${TIMES.map(([v, l]) => `<option value="${v}" ${r.t === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }
  sorts.innerHTML = html;

  $$('#sidebar .nav-item').forEach(a => {
    const nav = a.dataset.nav;
    const active = (nav === '/' && r.kind === 'front') || (r.sub && nav && nav.toLowerCase() === '/r/' + r.sub.toLowerCase() && r.kind === 'sub');
    a.classList.toggle('active', !!active);
  });
}

function feedPath(r) {
  if (r.kind === 'front') return { path: '/' + r.sort, params: { t: r.t } };
  if (r.kind === 'sub') return { path: `/r/${r.sub}/${r.sort}`, params: { t: r.t } };
  if (r.kind === 'user') return { path: `/user/${r.user}/overview`, params: { sort: r.sort, t: r.t } };
  if (r.kind === 'search') {
    const params = { q: r.q, sort: r.sort, t: r.t, type: 'link' };
    if (r.sub) params.restrict_sr = 'on';
    return { path: r.sub ? `/r/${r.sub}/search` : '/search', params };
  }
}

async function loadFeed(reset) {
  const r = parseRoute();
  if (r.kind === 'post') {
    // Deep link to a post: show its subreddit and open the post.
    openPostById(r.postId, r.commentId);
    history.replaceState(null, '', `#/r/${r.sub}/hot`);
    return loadFeed(true);
  }
  const key = feedKey(r);
  if (reset || key !== feedState.key) {
    feedState.controller?.abort();
    Object.assign(feedState, { route: r, after: null, loading: false, done: false, posts: [], seen: new Set(), key, controller: new AbortController() });
    feedEl.innerHTML = '';
    feedEl.scrollTop = 0;
    renderFeedHeader(r);
    closeSidebar();
  }
  if (feedState.loading || feedState.done) return;
  feedState.loading = true;
  const status = document.createElement('div');
  status.className = 'feed-status';
  status.innerHTML = '<div class="spinner"></div>';
  feedEl.appendChild(status);

  const { path, params } = feedPath(r);
  try {
    const json = await api(path, { limit: 50, ...(feedState.after ? { after: feedState.after, count: feedState.posts.length } : {}), ...params },
      { signal: feedState.controller.signal });
    if (feedState.key !== key) return;
    status.remove();
    const children = (json.data?.children || []).filter(c => {
      if (feedState.seen.has(c.data.name)) return false;
      feedState.seen.add(c.data.name);
      return c.kind === 't3' || c.kind === 't1';
    });
    feedState.after = json.data?.after || null;
    feedState.done = !feedState.after;
    const frag = document.createDocumentFragment();
    for (const c of children) {
      feedState.posts.push(c);
      frag.appendChild(c.kind === 't3' ? renderPostItem(c.data) : renderUserComment(c.data));
    }
    feedEl.appendChild(frag);
    if (!feedState.posts.length) {
      feedEl.insertAdjacentHTML('beforeend', '<div class="feed-status">Nothing here.</div>');
    } else if (feedState.done) {
      feedEl.insertAdjacentHTML('beforeend', '<div class="feed-status">End of feed</div>');
    }
    feedState.loading = false;
    // Fill the viewport on tall screens.
    if (!feedState.done && feedEl.scrollHeight <= feedEl.clientHeight + 200) loadFeed(false);
  } catch (e) {
    feedState.loading = false;
    if (e.name === 'AbortError') return;
    status.innerHTML = errorBox(e);
    status.querySelector('[data-retry]')?.addEventListener('click', () => { status.remove(); loadFeed(false); });
  }
}

function errorBox(e) {
  const blocked = !settings.clientId && (e.status === 0 || e.status === 403 || e.status === 429);
  return `<div class="error-box"><b>Could not load</b>${esc(e.message)}
    ${blocked ? '<p class="muted small">Adding a Reddit API client ID in Settings usually fixes this.</p>' : ''}
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn" data-retry>Retry</button>
    ${blocked ? '<button class="btn" onclick="openSettings()">Settings</button>' : ''}</div></div>`;
}

function renderPostItem(p) {
  const gallery = app.classList.contains('layout-gallery');
  const el = document.createElement('article');
  el.className = (gallery ? 'card' : 'post-row') + (visited.has(p.id) ? ' visited' : '') + (p.id === selectedId ? ' selected' : '');
  el.dataset.id = p.id;
  const kind = postKind(p);
  const thumb = thumbFor(p);
  const blur = (p.over_18 && !settings.showNsfw) || p.spoiler;
  const badge = kind === 'gallery' ? `${galleryItems(p).length} pics` : (kind === 'video' || kind === 'gifv') ? 'video' : '';
  const tags = [
    p.stickied ? '<span class="tag pin">Pinned</span>' : '',
    p.over_18 ? '<span class="tag nsfw">NSFW</span>' : '',
    p.spoiler ? '<span class="tag spoiler">Spoiler</span>' : '',
    p.link_flair_text ? `<span class="tag">${esc(p.link_flair_text)}</span>` : '',
  ].join('');
  const showSub = !(feedState.route?.kind === 'sub' && feedState.route.sub.toLowerCase() === p.subreddit.toLowerCase());
  const meta = `<div class="pr-meta">${showSub ? `<span class="sub">r/${esc(p.subreddit)}</span>` : ''}
      <span>u/${esc(p.author)}</span><span>${timeAgo(p.created_utc)}</span>${!p.is_self ? `<span>${esc(p.domain)}</span>` : ''}${tags}</div>`;
  const stats = `<div class="pr-stats"><span>${ICON_UP}${fmtNum(p.score)}</span><span>${ICON_COMMENT}${fmtNum(p.num_comments)}</span></div>`;

  if (gallery) {
    let media;
    if (thumb) {
      const big = kind === 'gallery' ? thumb : (bestPreview(p, 640)?.url || thumb);
      media = `<div class="card-media ${blur ? 'blur' : ''}"><img src="${esc(big)}" alt="" loading="lazy">${badge ? `<span class="badge">${badge}</span>` : ''}</div>`;
    } else if (p.selftext) {
      media = `<div class="card-text">${esc(p.selftext.slice(0, 600))}</div>`;
    } else {
      media = `<div class="card-media" style="display:flex;align-items:center;justify-content:center;color:var(--fg-muted)">${kind === 'link' ? ICON_LINK : ICON_TEXT}</div>`;
    }
    el.innerHTML = `${media}<div class="card-body">${meta}<div class="pr-title">${esc(p.title)}</div>${stats}</div>`;
  } else {
    const thumbHtml = thumb
      ? `<div class="pr-thumb ${blur ? 'blur' : ''}"><img src="${esc(thumb)}" alt="" loading="lazy">${badge ? `<span class="badge">${badge}</span>` : ''}</div>`
      : (kind === 'link' ? `<div class="pr-thumb">${ICON_LINK}</div>` : '');
    el.innerHTML = `<div class="pr-body">${meta}<div class="pr-title">${esc(p.title)}</div>${stats}</div>${thumbHtml}`;
  }
  el.addEventListener('click', () => selectPost(p.id));
  return el;
}

function renderUserComment(c) {
  const el = document.createElement('article');
  el.className = app.classList.contains('layout-gallery') ? 'card' : 'post-row';
  el.dataset.id = c.link_id.replace('t3_', '');
  el.innerHTML = `<div class="pr-body${app.classList.contains('layout-gallery') ? ' card-body' : ''}">
    <div class="pr-meta"><span class="sub">r/${esc(c.subreddit)}</span><span>comment</span><span>${timeAgo(c.created_utc)}</span></div>
    <div class="pr-title">${esc(c.link_title || '')}</div>
    <div class="md small" style="max-height:8.5em;overflow:hidden">${sanitize(c.body_html)}</div>
    <div class="pr-stats"><span>${ICON_UP}${fmtNum(c.score)}</span></div></div>`;
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('a')) return;
    openPostById(c.link_id.replace('t3_', ''), c.id);
  });
  return el;
}

/* infinite scroll */
feedEl.addEventListener('scroll', () => {
  if (feedEl.scrollTop + feedEl.clientHeight > feedEl.scrollHeight - 1200) loadFeed(false);
}, { passive: true });

/* ---------------------------------------------------------------------
   Detail: post + comments
   --------------------------------------------------------------------- */
let detailController = null;
let currentPost = null;

function findPost(id) {
  return feedState.posts.find(c => c.kind === 't3' && c.data.id === id)?.data || null;
}

function selectPost(id) {
  const post = findPost(id);
  if (post) openPost(post);
  else openPostById(id);
}

function setSelected(id) {
  selectedId = id;
  $$('#feed .selected').forEach(el => el.classList.remove('selected'));
  const el = feedEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.add('selected', 'visited');
    const r = el.getBoundingClientRect();
    const fr = feedEl.getBoundingClientRect();
    if (r.top < fr.top || r.bottom > fr.bottom) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function showDetail() {
  if (!app.classList.contains('show-detail')) {
    app.classList.add('show-detail');
    if (isOverlayDetail()) history.pushState({ detail: true }, '', location.hash);
  }
}
function hideDetail() {
  app.classList.remove('show-detail');
  pauseMedia();
}
function isOverlayDetail() {
  return window.innerWidth < 760 || app.classList.contains('layout-gallery');
}
function pauseMedia() { $$('video', detailEl).forEach(v => v.pause()); }

async function openPostById(id, commentId) {
  showDetail();
  detailEl.innerHTML = '<div class="feed-status"><div class="spinner"></div></div>';
  try {
    const json = await api(`/comments/${id}`, { limit: 1 });
    const post = json[0].data.children[0].data;
    openPost(post, commentId);
  } catch (e) {
    detailEl.innerHTML = `<div class="detail-inner">${errorBox(e)}</div>`;
  }
}

function openPost(post, focusComment) {
  pauseMedia();
  currentPost = post;
  markVisited(post.id);
  setSelected(post.id);
  showDetail();
  $('#detail-crumb').textContent = `r/${post.subreddit}`;
  $('#btn-open-reddit').href = 'https://www.reddit.com' + post.permalink;

  const kind = postKind(post);
  const xp = post.crosspost_parent_list?.[0];
  const body = xp && !post.selftext_html ? xp : post;
  const tags = [
    post.over_18 ? '<span class="tag nsfw">NSFW</span>' : '',
    post.spoiler ? '<span class="tag spoiler">Spoiler</span>' : '',
    post.link_flair_text ? `<span class="tag">${esc(post.link_flair_text)}</span>` : '',
  ].join('');

  detailEl.innerHTML = `<div class="detail-inner">
    <div class="d-meta"><a data-nav="/r/${esc(post.subreddit)}">r/${esc(post.subreddit)}</a>
      <span>by <a data-nav="/u/${esc(post.author)}">u/${esc(post.author)}</a></span>
      <span>${timeAgo(post.created_utc)} ago</span>${tags}</div>
    <h2 class="d-title">${esc(post.title)}</h2>
    ${xp ? `<div class="xpost">Crossposted from <a data-nav="/r/${esc(xp.subreddit)}">r/${esc(xp.subreddit)}</a></div>` : ''}
    <div id="d-media-slot"></div>
    ${body.selftext_html ? `<div class="md selftext">${sanitize(body.selftext_html)}</div>` : ''}
    <div class="d-stats"><span><b>${fmtNum(post.score)}</b> points</span><span>${Math.round((post.upvote_ratio || 0) * 100)}% upvoted</span><span><b>${fmtNum(post.num_comments)}</b> comments</span></div>
    <div class="c-toolbar"><h3>Comments</h3>
      <select id="c-sort">${['confidence:Best', 'top:Top', 'new:New', 'controversial:Controversial', 'old:Old', 'qa:Q&A']
        .map(o => { const [v, l] = o.split(':'); const cur = store.get('commentSort', 'confidence'); return `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`; }).join('')}</select>
    </div>
    <div class="comments" id="comments"><div class="feed-status"><div class="spinner"></div></div></div>
  </div>`;
  detailEl.scrollTop = 0;

  const slot = $('#d-media-slot');
  const mediaEl = renderMedia(post, kind);
  if (mediaEl) slot.replaceWith(mediaEl); else slot.remove();

  $('#c-sort').addEventListener('change', (e) => {
    store.set('commentSort', e.target.value);
    loadComments(post, null);
  });
  loadComments(post, focusComment);
}

function renderMedia(post, kind) {
  const src = post.crosspost_parent_list?.[0] || post;
  const blur = post.over_18 && !settings.showNsfw;
  const wrap = document.createElement('div');
  wrap.className = 'd-media' + (blur ? ' blur' : '');
  if (blur) {
    wrap.addEventListener('click', (e) => { if (wrap.classList.contains('blur')) { e.stopPropagation(); e.preventDefault(); wrap.classList.remove('blur'); wrap.querySelectorAll('.blurred').forEach(x => x.style.filter = ''); } }, true);
  }
  const blurStyle = blur ? ' style="filter:blur(30px)" class="blurred"' : '';

  if (kind === 'gallery') {
    const items = galleryItems(post);
    wrap.innerHTML = `<div class="gallery">${items.map((it, i) =>
      `<figure>${it.mp4 ? `<video src="${esc(it.mp4)}" muted loop playsinline autoplay${blurStyle}></video>` : `<img src="${esc(it.display)}" data-i="${i}" alt=""${blurStyle} loading="lazy">`}${it.caption ? `<figcaption>${esc(it.caption)}</figcaption>` : ''}</figure>`).join('')}</div>
      <span class="gal-count">1 / ${items.length}</span>
      ${items.length > 1 ? `<button class="icon-btn gal-nav prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59Z"/></svg></button>
      <button class="icon-btn gal-nav next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6-6-6Z"/></svg></button>` : ''}`;
    const track = $('.gallery', wrap);
    const counter = $('.gal-count', wrap);
    track.addEventListener('scroll', () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      counter.textContent = `${i + 1} / ${items.length}`;
    }, { passive: true });
    $('.gal-nav.prev', wrap)?.addEventListener('click', () => track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' }));
    $('.gal-nav.next', wrap)?.addEventListener('click', () => track.scrollBy({ left: track.clientWidth, behavior: 'smooth' }));
    track.addEventListener('click', (e) => {
      const img = e.target.closest('img[data-i]');
      if (img) openLightbox(items.filter(x => !x.mp4).map(x => x.full), Number(img.dataset.i));
    });
    return wrap;
  }
  if (kind === 'video') {
    const v = redditVideo(post);
    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    if (settings.autoplay) { video.autoplay = true; video.muted = true; }
    const poster = bestPreview(src, 1080);
    if (poster) video.poster = poster.url;
    const canHls = video.canPlayType('application/vnd.apple.mpegurl');
    video.src = unescUrl(canHls && v.hls_url ? v.hls_url : v.fallback_url);
    if (v.width && v.height) video.style.aspectRatio = `${v.width} / ${v.height}`;
    if (blur) { video.style.filter = 'blur(30px)'; video.classList.add('blurred'); }
    wrap.appendChild(video);
    return wrap;
  }
  if (kind === 'gifv') {
    const url = (post.url_overridden_by_dest || post.url).replace(/\.gifv$/i, '.mp4');
    wrap.innerHTML = `<video src="${esc(url)}" controls autoplay muted loop playsinline${blurStyle}></video>`;
    return wrap;
  }
  if (kind === 'image') {
    const url = unescUrl(post.url_overridden_by_dest || post.url);
    const isGif = /\.gif(\?|$)/i.test(url);
    const prev = bestPreview(src, 1600);
    const mp4 = src.preview?.images?.[0]?.variants?.mp4?.source?.url;
    if (isGif && mp4) {
      wrap.innerHTML = `<video src="${esc(unescUrl(mp4))}" autoplay muted loop playsinline controls${blurStyle}></video>`;
    } else {
      const display = isGif ? url : (prev?.url || url);
      wrap.innerHTML = `<img src="${esc(display)}" alt=""${blurStyle}>`;
      $('img', wrap).addEventListener('click', () => openLightbox([url]));
      $('img', wrap).addEventListener('error', function onErr() {
        this.removeEventListener('error', onErr);
        if (this.src !== url) this.src = url;
      });
    }
    return wrap;
  }
  if (kind === 'embed') {
    const e = src.secure_media_embed?.media_domain_url ? src.secure_media_embed : null;
    if (e) {
      wrap.innerHTML = `<iframe src="${esc(unescUrl(e.media_domain_url))}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`;
      if (e.width && e.height) $('iframe', wrap).style.aspectRatio = `${e.width} / ${e.height}`;
      return wrap;
    }
  }
  if (kind === 'link' || kind === 'embed') {
    const url = unescUrl(post.url_overridden_by_dest || post.url);
    if (/reddit\.com\/r\/[^/]+\/comments\//.test(url) && post.crosspost_parent_list) return null;
    const a = document.createElement('a');
    a.className = 'link-card';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const t = thumbFor(post);
    a.innerHTML = `${t ? `<img src="${esc(t)}" alt="">` : `<span class="pr-thumb" style="width:56px;height:56px">${ICON_LINK}</span>`}
      <div class="lc-text"><div class="lc-domain">${esc(post.domain)}</div><div class="lc-url">${esc(url)}</div></div>`;
    return a;
  }
  return null;
}

/* ---- comments ---- */
const RAILS = ['--rail-1', '--rail-2', '--rail-3', '--rail-4', '--rail-5', '--rail-6'];

async function loadComments(post, focusComment) {
  const box = $('#comments');
  if (!box) return;
  detailController?.abort();
  detailController = new AbortController();
  box.innerHTML = '<div class="feed-status"><div class="spinner"></div></div>';
  const sort = store.get('commentSort', 'confidence');
  const params = { sort, limit: 300, depth: 10 };
  if (focusComment) { params.comment = focusComment; params.context = 3; }
  try {
    const json = await api(`/comments/${post.id}`, params, { signal: detailController.signal });
    if (currentPost?.id !== post.id) return;
    const listing = json[1].data.children;
    box.innerHTML = '';
    if (focusComment) {
      const all = document.createElement('button');
      all.className = 'more-btn';
      all.textContent = 'View all comments';
      all.addEventListener('click', () => loadComments(post, null));
      box.appendChild(all);
    }
    if (!listing.length) { box.innerHTML += '<div class="feed-status">No comments yet.</div>'; return; }
    box.appendChild(renderCommentList(listing, post, 0));
  } catch (e) {
    if (e.name === 'AbortError') return;
    box.innerHTML = errorBox(e);
    box.querySelector('[data-retry]')?.addEventListener('click', () => loadComments(post, focusComment));
  }
}

function renderCommentList(children, post, depth) {
  const frag = document.createDocumentFragment();
  for (const c of children) {
    if (c.kind === 't1') frag.appendChild(renderComment(c.data, post, depth));
    else if (c.kind === 'more') frag.appendChild(renderMore(c.data, post, depth));
  }
  return frag;
}

function countDescendants(c) {
  let n = 0;
  const kids = c.replies?.data?.children || [];
  for (const k of kids) {
    if (k.kind === 't1') n += 1 + countDescendants(k.data);
    else if (k.kind === 'more') n += k.data.count || 0;
  }
  return n;
}

function renderComment(c, post, depth) {
  const el = document.createElement('div');
  el.className = 'comment';
  el.style.setProperty('--rail', `var(${RAILS[depth % RAILS.length]})`);
  const hidden = countDescendants(c);
  const isOp = c.author === post.author;
  el.innerHTML = `<div class="c-head" data-hidden="${hidden ? `+${hidden} hidden` : 'collapsed'}">
      <span class="c-author ${isOp ? 'op' : ''}">${esc(c.author)}${isOp ? ' (OP)' : ''}</span>
      ${c.author_flair_text ? `<span class="c-flair">${esc(c.author_flair_text)}</span>` : ''}
      <span>${c.score_hidden ? '-' : fmtNum(c.score)} pts</span><span>${timeAgo(c.created_utc)}</span>
      ${c.edited ? '<span>edited</span>' : ''}${c.stickied ? '<span class="tag pin">Pinned</span>' : ''}
    </div>
    <div class="c-body md">${sanitize(c.body_html)}</div>`;
  if (c.replies?.data?.children?.length) {
    const kids = document.createElement('div');
    kids.className = 'c-children';
    kids.appendChild(renderCommentList(c.replies.data.children, post, depth + 1));
    el.appendChild(kids);
  }
  if (c.collapsed) el.classList.add('collapsed');
  return el;
}

function renderMore(m, post, depth) {
  const btn = document.createElement('button');
  btn.className = 'more-btn';
  const isContinue = !m.count || !m.children?.length;
  btn.textContent = isContinue ? 'Continue this thread' : `Load ${m.count} more ${m.count === 1 ? 'reply' : 'replies'}`;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading...';
    try {
      let things;
      if (isContinue) {
        const parentId = m.parent_id.replace(/^t1_/, '');
        const json = await api(`/comments/${post.id}`, { comment: parentId, sort: store.get('commentSort', 'confidence'), depth: 10, limit: 300 });
        const root = json[1].data.children[0];
        things = root?.data?.replies?.data?.children || [];
        btn.replaceWith(renderCommentList(things, post, depth));
      } else {
        const ids = m.children.slice(0, 100);
        const json = await api('/api/morechildren', {
          api_type: 'json', link_id: post.name, children: ids.join(','), sort: store.get('commentSort', 'confidence'),
        });
        things = json.json?.data?.things || [];
        const tree = buildTree(things, m.parent_id);
        const frag = renderCommentList(tree, post, depth);
        const rest = m.children.slice(100);
        if (rest.length) frag.appendChild(renderMore({ ...m, children: rest, count: m.count - ids.length }, post, depth));
        btn.replaceWith(frag);
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Failed to load. Tap to retry.';
    }
  });
  return btn;
}

/* morechildren returns a flat list; rebuild the tree under parentName */
function buildTree(things, parentName) {
  const byName = new Map();
  const roots = [];
  for (const t of things) {
    if (t.kind === 't1') t.data.replies = { data: { children: [] } };
    byName.set(t.data.name || ('more_' + t.data.id), t);
  }
  for (const t of things) {
    const parent = byName.get(t.data.parent_id);
    if (parent && parent.kind === 't1') parent.data.replies.data.children.push(t);
    else if (t.data.parent_id === parentName || !parent) roots.push(t);
  }
  return roots;
}

/* collapse comments, reveal spoilers, intercept internal links */
detailEl.addEventListener('click', (e) => {
  const spoiler = e.target.closest('.md-spoiler-text');
  if (spoiler && !spoiler.classList.contains('revealed')) { spoiler.classList.add('revealed'); e.preventDefault(); return; }
  const head = e.target.closest('.c-head');
  if (head) {
    const c = head.parentElement;
    c.classList.toggle('collapsed');
    // keep the collapsed comment in view
    const r = c.getBoundingClientRect();
    const dr = detailEl.getBoundingClientRect();
    if (r.top < dr.top) detailEl.scrollTop += r.top - dr.top - 8;
    return;
  }
});

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    goTo(nav.dataset.nav);
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a || a.id === 'btn-open-reddit') return;
  const internal = parseRedditUrl(a.getAttribute('href'));
  if (internal) {
    e.preventDefault();
    if (internal.post) openPostById(internal.post, internal.comment);
    else goTo(internal.path);
  }
});

function parseRedditUrl(href) {
  if (!href) return null;
  let u;
  try { u = new URL(href, 'https://www.reddit.com'); } catch { return null; }
  if (!/(^|\.)reddit\.com$/i.test(u.hostname) && u.hostname !== 'redd.it') return null;
  if (u.hostname === 'redd.it') return { post: u.pathname.slice(1) };
  const m = u.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/[^/]*\/([a-z0-9]+))?/i);
  if (m) return { post: m[2], comment: m[3] || null };
  const s = u.pathname.match(/^\/(r|u|user)\/([^/]+)\/?$/i);
  if (s) return { path: `/${s[1] === 'r' ? 'r' : 'u'}/${s[2]}` };
  return null;
}

function goTo(path) {
  // path like "/", "/r/pics", "/u/someone"
  const cur = parseRoute();
  const r = { kind: 'front', sub: null, user: null, sort: 'hot', t: cur.t || 'day' };
  const m = path.match(/^\/(r|u)\/([^/]+)/);
  if (m && m[1] === 'r') { r.kind = 'sub'; r.sub = m[2]; }
  else if (m && m[1] === 'u') { r.kind = 'user'; r.user = m[2]; r.sort = 'new'; }
  if (isOverlayDetail()) hideDetail();
  navigate(routeToHash(r));
}

/* ---------------------------------------------------------------------
   Lightbox
   --------------------------------------------------------------------- */
const lb = $('#lightbox');
const lbTrack = $('#lb-track');
function openLightbox(urls, index = 0) {
  lbTrack.innerHTML = urls.map(u => `<div class="lb-item"><img src="${esc(u)}" alt=""></div>`).join('');
  lb.hidden = false;
  requestAnimationFrame(() => { lbTrack.scrollLeft = index * lbTrack.clientWidth; updateLbCount(); });
  lb._count = urls.length;
}
function closeLightbox() { lb.hidden = true; lbTrack.innerHTML = ''; }
function updateLbCount() {
  const n = lb._count || 1;
  $('#lb-count').textContent = n > 1 ? `${Math.round(lbTrack.scrollLeft / lbTrack.clientWidth) + 1} / ${n}` : '';
}
lbTrack.addEventListener('scroll', updateLbCount, { passive: true });
$('#lb-close').addEventListener('click', closeLightbox);
lbTrack.addEventListener('click', (e) => {
  const item = e.target.closest('.lb-item');
  if (!item) return;
  if (e.target.tagName !== 'IMG') { closeLightbox(); return; }
  const zoom = !item.classList.contains('zoomed');
  item.classList.toggle('zoomed', zoom);
  if (zoom) {
    const img = e.target;
    const rx = e.offsetX / img.clientWidth, ry = e.offsetY / img.clientHeight;
    requestAnimationFrame(() => {
      item.scrollLeft = img.naturalWidth * rx - item.clientWidth / 2;
      item.scrollTop = img.naturalHeight * ry - item.clientHeight / 2;
    });
  }
});

/* ---------------------------------------------------------------------
   Sidebar: favorites and subreddit search
   --------------------------------------------------------------------- */
function renderFavorites() {
  const nav = $('#favorites');
  const sorted = [...favorites].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  nav.innerHTML = sorted.map(s =>
    `<a class="nav-item" data-nav="/r/${esc(s)}"><span class="sub-icon">${esc(s[0].toUpperCase())}</span>${esc(s)}</a>`).join('')
    || '<div class="muted small" style="padding:6px 10px">Tap the star on a subreddit to add it here.</div>';
  if (feedState.route) renderFeedHeader(feedState.route);
}

function toggleFavorite() {
  const r = feedState.route;
  if (r?.kind !== 'sub') return;
  const i = favorites.findIndex(f => f.toLowerCase() === r.sub.toLowerCase());
  if (i >= 0) { favorites.splice(i, 1); toast(`Removed r/${r.sub}`); }
  else { favorites.push(r.sub); toast(`Added r/${r.sub}`); }
  saveFavorites();
  renderFavorites();
}

const subInput = $('#sub-search');
const subResults = $('#sub-results');
let subTimer, subController;
subInput.addEventListener('input', () => {
  clearTimeout(subTimer);
  const q = subInput.value.trim();
  if (!q) { subResults.hidden = true; return; }
  subTimer = setTimeout(async () => {
    subController?.abort();
    subController = new AbortController();
    const base = [
      `<a data-go="sub" data-v="${esc(q.replace(/^r\//i, '').replace(/\s+/g, ''))}">Go to r/${esc(q.replace(/^r\//i, '').replace(/\s+/g, ''))}</a>`,
      `<a data-go="search" data-v="${esc(q)}">Search posts for "${esc(q)}"</a>`,
    ];
    if (feedState.route?.kind === 'sub') base.push(`<a data-go="search-sub" data-v="${esc(q)}">Search r/${esc(feedState.route.sub)}</a>`);
    subResults.innerHTML = base.join('');
    subResults.hidden = false;
    try {
      const json = await api('/subreddits/search', { q, limit: 8, include_over_18: settings.showNsfw ? 'on' : 'off' }, { signal: subController.signal });
      const rows = (json.data?.children || []).map(c => c.data).map(s =>
        `<a data-go="sub" data-v="${esc(s.display_name)}"><span class="sub-icon" ${s.icon_img || s.community_icon ? `style="background-image:url('${esc(unescUrl(s.icon_img || s.community_icon))}')"` : ''}>${s.icon_img || s.community_icon ? '' : esc(s.display_name[0])}</span>${esc(s.display_name)}<span class="sr-meta">${fmtNum(s.subscribers)}</span></a>`);
      if (subInput.value.trim() === q) subResults.innerHTML = base.concat(rows).join('');
    } catch { /* keep the basic options */ }
  }, 250);
});
$('#sub-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const first = subResults.querySelector('a');
  if (first) first.click();
});
subResults.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-go]');
  if (!a) return;
  const v = a.dataset.v;
  subInput.value = '';
  subResults.hidden = true;
  subInput.blur();
  if (a.dataset.go === 'sub') goTo('/r/' + v);
  else navigate(routeToHash({ kind: 'search', q: v, sort: 'relevance', t: 'all', sub: a.dataset.go === 'search-sub' ? feedState.route.sub : null }));
});

function openSidebar() { app.classList.add('side-open'); $('#scrim').hidden = false; }
function closeSidebar() { app.classList.remove('side-open'); $('#scrim').hidden = true; }
$('#btn-sidebar').addEventListener('click', () => app.classList.contains('side-open') ? closeSidebar() : openSidebar());
$('#scrim').addEventListener('click', closeSidebar);

/* ---------------------------------------------------------------------
   Header controls
   --------------------------------------------------------------------- */
$('#sorts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  const r = { ...feedState.route, sort: b.dataset.sort };
  navigate(routeToHash(r));
});
$('#sorts').addEventListener('change', (e) => {
  if (e.target.id !== 'time-select') return;
  navigate(routeToHash({ ...feedState.route, t: e.target.value }));
});
$('#btn-refresh').addEventListener('click', () => loadFeed(true));
$('#btn-fav').addEventListener('click', toggleFavorite);
$('#btn-layout').addEventListener('click', () => {
  settings.layout = settings.layout === 'gallery' ? 'split' : 'gallery';
  saveSettings();
  app.classList.remove('detail-full');
  if (settings.layout === 'gallery') app.classList.remove('show-detail');
  applySettings();
  rerenderFeed();
});
$('#btn-expand').addEventListener('click', toggleFull);
$('#btn-back').addEventListener('click', () => {
  if (history.state?.detail) history.back(); else hideDetail();
});
$('#btn-share').addEventListener('click', async () => {
  if (!currentPost) return;
  const url = 'https://www.reddit.com' + currentPost.permalink;
  try {
    if (navigator.share) await navigator.share({ title: currentPost.title, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* cancelled */ }
});

function toggleFull() {
  if (isOverlayDetail()) return;
  app.classList.toggle('detail-full');
}

function rerenderFeed() {
  const items = feedState.posts;
  const frag = document.createDocumentFragment();
  for (const c of items) frag.appendChild(c.kind === 't3' ? renderPostItem(c.data) : renderUserComment(c.data));
  const tail = $$('.feed-status', feedEl).pop();
  feedEl.innerHTML = '';
  feedEl.appendChild(frag);
  if (tail) feedEl.appendChild(tail);
}

window.addEventListener('popstate', () => {
  if (app.classList.contains('show-detail') && isOverlayDetail() && !history.state?.detail) hideDetail();
});

/* ---------------------------------------------------------------------
   Pane resizing
   --------------------------------------------------------------------- */
(function setupDivider() {
  const div = $('#divider');
  let startX, startW;
  div.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startW = $('#feed-pane').getBoundingClientRect().width;
    div.setPointerCapture(e.pointerId);
    div.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  div.addEventListener('pointermove', (e) => {
    if (!div.classList.contains('dragging')) return;
    const max = window.innerWidth * 0.65;
    const w = Math.round(Math.min(max, Math.max(300, startW + e.clientX - startX)));
    settings.feedWidth = w;
    document.documentElement.style.setProperty('--feed-w', w + 'px');
  });
  const end = () => {
    if (!div.classList.contains('dragging')) return;
    div.classList.remove('dragging');
    document.body.classList.remove('resizing');
    saveSettings();
  };
  div.addEventListener('pointerup', end);
  div.addEventListener('pointercancel', end);
  div.addEventListener('dblclick', () => {
    settings.feedWidth = 440;
    applySettings();
    saveSettings();
  });
})();

/* ---------------------------------------------------------------------
   Keyboard (Magic Keyboard / Smart Keyboard)
   --------------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if ($('#settings').open) return;
  if (!lb.hidden) {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') lbTrack.scrollBy({ left: lbTrack.clientWidth, behavior: 'smooth' });
    if (e.key === 'ArrowLeft') lbTrack.scrollBy({ left: -lbTrack.clientWidth, behavior: 'smooth' });
    return;
  }
  const items = $$('#feed [data-id]');
  const idx = items.findIndex(el => el.dataset.id === selectedId);
  switch (e.key) {
    case 'j': case 'ArrowDown':
      if (e.key === 'ArrowDown' && document.activeElement === detailEl) return;
      e.preventDefault();
      if (items[idx + 1]) selectPost(items[idx + 1].dataset.id);
      break;
    case 'k': case 'ArrowUp':
      if (e.key === 'ArrowUp' && document.activeElement === detailEl) return;
      e.preventDefault();
      if (idx > 0) selectPost(items[idx - 1].dataset.id);
      break;
    case ' ':
      e.preventDefault();
      detailEl.scrollBy({ top: (e.shiftKey ? -1 : 1) * detailEl.clientHeight * 0.85, behavior: 'smooth' });
      break;
    case 'f': toggleFull(); break;
    case 'g': $('#btn-layout').click(); break;
    case 'r': loadFeed(true); break;
    case 'o':
      if (currentPost) window.open(unescUrl(currentPost.url_overridden_by_dest || currentPost.url), '_blank', 'noopener');
      break;
    case '/':
      e.preventDefault();
      if (window.innerWidth < 1100) openSidebar();
      subInput.focus();
      break;
    case 'Escape':
      if (app.classList.contains('side-open')) closeSidebar();
      else if (app.classList.contains('detail-full')) toggleFull();
      else if (isOverlayDetail() && app.classList.contains('show-detail')) $('#btn-back').click();
      break;
  }
});

/* ---------------------------------------------------------------------
   Settings dialog
   --------------------------------------------------------------------- */
function openSettings() {
  const dlg = $('#settings');
  const f = dlg.querySelector('form');
  f.theme.value = settings.theme;
  f.textSize.value = settings.textSize;
  f.showNsfw.checked = settings.showNsfw;
  f.autoplay.checked = settings.autoplay;
  f.clientId.value = settings.clientId;
  dlg.showModal();
}
window.openSettings = openSettings;
$('#btn-settings').addEventListener('click', openSettings);
$('#settings').addEventListener('close', () => {
  const dlg = $('#settings');
  if (dlg.returnValue !== 'save') return;
  const f = dlg.querySelector('form');
  const prevNsfw = settings.showNsfw;
  const prevClient = settings.clientId;
  settings.theme = f.theme.value;
  settings.textSize = f.textSize.value;
  settings.showNsfw = f.showNsfw.checked;
  settings.autoplay = f.autoplay.checked;
  settings.clientId = f.clientId.value.trim();
  saveSettings();
  applySettings();
  if (prevClient !== settings.clientId) { tokenCache = null; store.set('token', null); loadFeed(true); }
  else if (prevNsfw !== settings.showNsfw) rerenderFeed();
});

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
applySettings();
renderFavorites();
window.addEventListener('hashchange', () => loadFeed(false));
loadFeed(true);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
