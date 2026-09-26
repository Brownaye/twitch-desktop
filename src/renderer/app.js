/* global tw */
'use strict';
// The main window: Live (who is on now), Continue (what you left partway), VODs (past broadcasts), Channels
// (who you follow) and Settings. Streams play in the player panel (src/renderer/player.*).

// ---------- icons ----------
const ICONS = {
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  belloff: '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>',
  twitch: '<path d="M21 2H3v16h5v4l4-4h5l4-4V2z"/><path d="M11 11V7"/><path d="M16 11V7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  pin: '<path d="M12 17v5"/><path d="M8 3h8l-1 7 3 3H6l3-3z"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  rewind: '<polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>',
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.bell}</svg>`;

// ---------- state ----------
const S = {
  settings: {}, favourites: [], following: [], status: { channels: [] }, setup: {}, log: [],
  tab: 'live', settingsOpen: false, nowPlaying: null,
  vods: null, vodsLoading: false, vodFilter: { channel: '', unwatched: false }, vodShow: 60,
  cont: null, chanFilter: '', auth: { signedIn: false }, sched: null, schedLoading: false, stats: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const open = (url) => url && ask('open:external', url);
const REPO = 'https://github.com/Brownaye/twitch-desktop';

// A call to the main process that throws shows up as a snack rather than only in the console, and gives null.
async function ask(channel, ...args) {
  try { return await tw.invoke(channel, ...args); } catch (e) {
    console.error(channel, e);
    snack(friendly(e.message), true);
    return null;
  }
}
// Network codes and HTTP statuses read badly in a snack; the rest of the errors are already written for people.
function friendly(msg) {
  const m = String(msg || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim();
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(m)) return 'Could not reach Twitch. Check your internet connection.';
  if (/\b401\b|unauthori[sz]ed/i.test(m)) return 'Twitch did not accept your sign-in. Sign out and in again in Settings.';
  if (/\b429\b/.test(m)) return 'Twitch is limiting requests right now. Try again in a minute.';
  return m || 'Something went wrong.';
}
const fail = (r, fallback) => snack(friendly(r.error || fallback), true);
const signedIn = () => !!S.auth.signedIn;

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'now';
  const m = Math.floor(d / 60000); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const dd = Math.floor(h / 24); if (dd < 7) return `${dd}d`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const ago = (ts) => { const t = timeAgo(ts); return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : t; };
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, now)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
const fmtNum = (v) => (v == null ? '' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));
function fmtSpan(ms) {
  const m = Math.max(1, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
let snackTimer = null;
function snack(msg, err = false) {
  const el = $('#snack');
  el.textContent = msg; el.classList.toggle('err', !!err); el.hidden = false;
  clearTimeout(snackTimer); snackTimer = setTimeout(() => { el.hidden = true; }, err ? 6000 : 3000);
}

// ---------- channels ----------
function channels() {
  const fav = new Set(S.favourites);
  return (S.status.channels || []).map((c) => ({ ...c, toast: fav.has(c.login) }));
}
const liveChannels = () => channels().filter((c) => c.live);

const TAG_NOISE = /^(drops(enabled)?|aioptedout|nobackseating|english)$/i;
const LANGS = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', ru: 'Russian', ja: 'Japanese', ko: 'Korean', pt: 'Portuguese', it: 'Italian', sv: 'Swedish', no: 'Norwegian', da: 'Danish', nl: 'Dutch', pl: 'Polish', fi: 'Finnish' };
const eqHtml = () => '<span class="eq" title="Playing"><i></i><i></i><i></i></span>';

function avatarHtml(c, cls) {
  return c.avatar ? `<img class="${cls}" src="${esc(c.avatar)}" alt="" data-ph="${esc(icon('twitch'))}">` : `<span class="${cls} ph">${icon('twitch')}</span>`;
}
function bellHtml(c) {
  const tip = c.toast ? `Favourite: ${c.display || c.login} is listed first and you get a notification when they go live. Click to remove.` : `Make ${c.display || c.login} a favourite: listed first, with a notification when they go live`;
  return `<button class="tw-bell ${c.toast ? 'on' : ''}" data-fav="${esc(c.login)}" title="${esc(tip)}" aria-pressed="${c.toast ? 'true' : 'false'}">${icon(c.toast ? 'bell' : 'belloff')}</button>`;
}
function keepHtml(c) {
  const on = (S.settings.twitchKeepActive || []).includes(c.login);
  const tip = on ? 'Kept loaded: while live, this stream stays loaded (muted, out of sight) in the player so switching to it is instant. Click to stop.' : 'Keep loaded for instant switching: while live, this stream stays loaded (muted, out of sight) in the player';
  return `<button class="tw-keep ${on ? 'on' : ''}" data-keep="${esc(c.login)}" title="${esc(tip)}" aria-pressed="${on ? 'true' : 'false'}">${icon('bolt')}</button>`;
}

const vodBtnHtml = (c) => `<button class="tw-vodbtn" data-vods="${esc(c.login)}" title="Past broadcasts (VODs)" aria-label="Past broadcasts from ${esc(c.display || c.login)}">${icon('film')}</button>`;

function liveRowHtml(c) {
  const since = Date.parse(c.startedAt) || Date.now();
  const extras = [c.game, c.peak && c.peak > (c.viewers || 0) ? `peak ${fmtNum(c.peak)}` : '', c.language && c.language !== 'en' ? LANGS[c.language] || c.language.toUpperCase() : '', c.mature ? '18+' : '']
    .filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
  const tags = (c.tags || []).filter((t) => !TAG_NOISE.test(t) && !Object.values(LANGS).includes(t)).slice(0, 3).map((t) => `<span class="tw-tag">${esc(t)}</span>`).join('');
  const playing = S.nowPlaying === `live:${c.login}`;
  return `<div class="tw live ${playing ? 'playing' : ''}" data-live="${esc(c.login)}" title="Watch ${esc(c.display)}" role="button" tabindex="0" aria-label="Watch ${esc(c.display)} live">
    <div class="tw-thumb">${c.thumb ? `<img src="${esc(c.thumb)}" alt="" data-drop>` : ''}<span class="tw-badge">LIVE</span>${playing ? eqHtml() : `<span class="tw-hoverplay">${icon('play')}</span>`}<button class="tw-start" data-start="${esc(c.login)}" title="Watch from the beginning of this stream" aria-label="Watch ${esc(c.display)} from the beginning of this stream">${icon('rewind')}</button><button class="tw-ext" data-ext="${esc(c.url)}" title="Open on twitch.tv" aria-label="Open ${esc(c.display)} on twitch.tv">${icon('external')}</button><span class="tw-viewers" title="Viewers">${icon('eye')}${fmtNum(c.viewers)}</span></div>
    <div class="tw-info">
      <div class="tw-head">${avatarHtml(c, 'tw-av')}<span class="tw-name">${esc(c.display)}</span><span class="tw-up" data-since="${since}" title="Live since ${new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}">${fmtSpan(Date.now() - since)}</span>${keepHtml(c)}${bellHtml(c)}</div>
      <div class="tw-title">${esc(c.title || '(no title)')}</div>
      <div class="tw-sub">${extras}${tags}</div>
    </div>
  </div>`;
}

function offRowHtml(c) {
  let when = 'offline';
  if (c.lastEndedAt) {
    when = `last live ${ago(c.lastEndedAt)}`;
    if (c.lastStartedAt) when += ` (${fmtSpan(c.lastEndedAt - c.lastStartedAt)})`;
  }
  const line = [c.title, c.game].filter(Boolean).join(' - ');
  return `<div class="tw off" data-url="${esc(c.url)}" title="${esc(line ? `${line} (click to open on twitch.tv)` : `Open ${c.display} on twitch.tv`)}" role="button" tabindex="0" aria-label="${esc(c.display)}, offline. Open on twitch.tv">
    ${avatarHtml(c, 'tw-av')}
    <div class="tw-info">
      <div class="tw-head"><span class="tw-name">${esc(c.display)}</span><span class="tw-last">${esc(when)}</span></div>
      ${line ? `<div class="tw-title">${esc(line)}</div>` : ''}
    </div>
    ${vodBtnHtml(c)}
    ${bellHtml(c)}
  </div>`;
}

// ---------- welcome (signed out) ----------
// Shown in place of every tab while signed out: all of it comes from Twitch, which needs a sign-in.
function welcomeHtml() {
  const a = S.auth;
  let body;
  if (!S.setup.clientId) {
    body = `<div class="welcome-note warn" role="alert">
        <strong>This build has no Twitch client ID</strong>
        <p>Twitch Desktop needs a Twitch application client ID before it can sign in. If you downloaded a release, please <a href="${REPO}/issues">report this on GitHub</a>.</p>
        <p class="muted small">Building from source? Set the <code>TWITCH_CLIENT_ID</code> environment variable, or fill in <code>BUILT_IN_CLIENT_ID</code> in <code>src/main/config.js</code>, then restart the app.</p>
      </div>`;
  } else if (a.pending) {
    body = `<div class="welcome-pending" aria-live="polite">
        <p>A Twitch sign-in window is open. Log in if asked, check the code matches, then press <strong>Activate</strong>.</p>
        <div class="welcome-code" aria-label="Your code">${esc(a.pending.code)}</div>
        <div class="row center"><span class="spinner" aria-hidden="true"></span><span class="muted small">Waiting for Twitch...</span><button class="btn ghost tiny" data-signin-cancel>Cancel</button></div>
      </div>`;
  } else {
    body = `<button class="btn primary big" data-signin>${icon('twitch')} Sign in with Twitch</button>
      <ol class="welcome-steps">
        <li>A Twitch window opens with your code filled in.</li>
        <li>Log in if asked, then press <strong>Activate</strong>.</li>
        <li>The channels you follow show up here.</li>
      </ol>`;
  }
  return `<div class="welcome">
    <div class="welcome-logo" aria-hidden="true">${icon('twitch')}</div>
    <h1>Twitch Desktop</h1>
    <p class="welcome-pitch">See who you follow is live, pick up what you left partway, and watch with chat in a player beside this window.</p>
    ${body}
    <p class="welcome-privacy muted small">Your sign-in stays on this computer and only goes to Twitch. The app has no server of its own and no tracking.</p>
  </div>`;
}
function renderWelcome(view) {
  view.innerHTML = welcomeHtml();
  view.querySelectorAll('[data-signin]').forEach((b) => b.addEventListener('click', signIn));
  view.querySelectorAll('[data-signin-cancel]').forEach((b) => b.addEventListener('click', cancelSignIn));
}

async function signIn() {
  document.querySelectorAll('[data-signin], #acct-in').forEach((b) => { b.disabled = true; });
  const r = await ask('auth:signIn');
  if (!r) { render(); return; }
  if (r.error) fail(r);
  S.auth = r;
  if (S.settingsOpen) renderAccount(); else render();
}
async function cancelSignIn() {
  const r = await ask('auth:cancel');
  if (r) S.auth = r;
  if (S.settingsOpen) renderAccount(); else render();
}

function renderLive(view) {
  if (!signedIn()) { renderWelcome(view); return; }
  const all = channels();
  if (!all.length) {
    if (!S.following.length) {
      view.innerHTML = `<div class="empty"><strong>You are not following anyone yet.</strong><br>Channels you follow on Twitch show up here.<br><span class="muted small">You can also add them by name in Channels.</span><div class="row center"><button class="btn" id="go-channels">Go to Channels</button></div></div>`;
      $('#go-channels').addEventListener('click', () => setTab('channels'));
    } else if (S.settings.paused) {
      view.innerHTML = '<div class="empty"><strong>Checking is paused.</strong><br>Resume it (power button, top right) to see who is live.</div>';
    } else {
      view.innerHTML = '<div class="empty"><strong>Checking your channels...</strong><br>This fills in after the first check.</div>';
    }
    return;
  }
  // Favourites (bell on) lead each group.
  const fav = (a, b) => (b.toast ? 1 : 0) - (a.toast ? 1 : 0);
  const live = all.filter((c) => c.live).sort((a, b) => fav(a, b) || (b.viewers || 0) - (a.viewers || 0));
  const off = all.filter((c) => !c.live).sort((a, b) => fav(a, b) || (b.lastEndedAt || 0) - (a.lastEndedAt || 0) || a.display.localeCompare(b.display));
  view.innerHTML = `
    <div class="tw-summary"><span class="tw-pill live">${live.length} live</span><span class="tw-pill">${off.length} offline</span><span class="muted small">Bell: favourite, notified when live · Bolt: keep loaded for instant switching</span></div>
    ${live.map(liveRowHtml).join('') || '<div class="empty small-empty">Nobody you follow is live right now.</div>'}
    ${off.length ? '<div class="day">Offline</div>' : ''}
    <div class="tw-offlist">${off.map(offRowHtml).join('')}</div>`;
  view.querySelectorAll('.tw').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (el.dataset.live) playLive(all.find((c) => c.login === el.dataset.live)); else open(el.dataset.url);
  }));
  view.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => playFromStart(all.find((c) => c.login === b.dataset.start))));
  view.querySelectorAll('.tw-ext').forEach((b) => b.addEventListener('click', () => open(b.dataset.ext)));
  view.querySelectorAll('.tw-vodbtn').forEach((b) => b.addEventListener('click', () => { S.vodFilter.channel = b.dataset.vods; S.vodShow = 60; setTab('vods'); }));
  bindRowButtons(view);
}

// Bell (favourite) and bolt (keep active) wherever they appear.
function bindRowButtons(root) {
  root.querySelectorAll('[data-fav]').forEach((b) => b.addEventListener('click', () => toggleFav(b.dataset.fav)));
  root.querySelectorAll('[data-keep]').forEach((b) => b.addEventListener('click', () => toggleKeep(b.dataset.keep)));
}

async function toggleFav(login) {
  const on = !S.favourites.includes(login);
  S.favourites = on ? [...S.favourites, login] : S.favourites.filter((l) => l !== login);
  render();
  const r = await ask('channels:favourite', { login, on });
  if (r && r.ok) snack(on ? `${login} is a favourite: listed first, with a notification when they go live` : `${login} is no longer a favourite`);
  else {
    if (r) fail(r, 'Could not change favourites');
    S.favourites = on ? S.favourites.filter((l) => l !== login) : [...S.favourites, login];
    render();
  }
}

// Keep loaded: the stream stays loaded (muted, out of sight) in the player while the channel is live.
async function toggleKeep(login) {
  const r = await ask('twitch:keep', { login });
  if (!r) return;
  if (!r.ok) { fail(r, 'Could not change that'); return; }
  S.settings.twitchKeepActive = r.list;
  render();
  snack(!r.on ? `${login} is no longer kept loaded` : r.playerOpen ? `${login} kept loaded: loading in the background now` : `${login} kept loaded: it loads in the background once the player is open`);
}

// ---------- playing ----------
async function playTwitch(meta) {
  S.nowPlaying = meta.kind === 'vod' ? meta.id : `live:${meta.login}`; // optimistic, so the row reacts at once
  render();
  const r = await ask('twitch:play', meta);
  if (!r || !r.ok) {
    if (r) fail(r, 'Could not open the player');
    S.nowPlaying = await ask('twitch:nowPlaying');
    render();
  }
}

function liveMeta(c) {
  return {
    kind: 'live', login: c.login, startedAt: Date.parse(c.startedAt) || null, display: c.display, avatar: c.avatar, title: c.title, game: c.game, thumb: c.thumb, link: c.url,
    sub: [c.game, c.viewers != null ? `${fmtNum(c.viewers)} watching` : ''].filter(Boolean).join(' · '),
  };
}
function playLive(c) { if (c) playTwitch(liveMeta(c)); }

// A live stream from its beginning: the VOD Twitch is recording of it, from 0:00.
async function playFromStart(c) {
  if (!c) return;
  snack(`Finding the start of ${c.display}'s stream...`);
  const r = await ask('twitch:fromStart', liveMeta(c));
  if (r && !r.ok) fail(r, 'Could not find the start of this stream');
}

function playVod(v, restart = false) {
  const p = v.progress;
  const resume = !restart && p && p.pos && !p.done ? ` · resuming at ${fmtDur(p.pos)}` : '';
  playTwitch({
    kind: 'vod', id: v.id, dur: v.dur, login: v.login, display: v.display, avatar: v.avatar, title: v.title, link: v.url, restart,
    thumb: v.thumb || (channels().find((c) => c.login === v.login && c.live) || {}).thumb || null,
    sub: `${dayLabel(v.createdAt)} · ${fmtDur(v.dur)}${resume}`,
  });
}

// ---------- Continue: VODs left partway and live streams you left ----------
async function loadContinue() {
  const r = await ask('twitch:continue');
  if (r && r.ok) S.cont = r.list;
  else {
    if (r) fail(r, 'Could not load Continue');
    S.cont = S.cont || [];
  }
  renderCounts();
  if (S.tab === 'continue' && !S.settingsOpen) render();
}

const sameBroadcast = (c, x) => c.login === x.login && c.live && (!x.startedAt || Math.abs(Date.parse(c.startedAt) - x.startedAt) < 15 * 60e3);

function contRowHtml(x, i) {
  const live = x.kind === 'live' && channels().find((c) => sameBroadcast(c, x));
  const playing = x.kind === 'vod' ? S.nowPlaying === x.id : S.nowPlaying === `live:${x.login}`;
  let thumb, state, acts;
  if (x.kind === 'vod') {
    const pct = Math.min(100, (x.pos / (x.dur || x.pos)) * 100);
    thumb = `${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy" data-drop>` : ''}<span class="vod-dur">${fmtDur(x.dur)}</span><span class="vod-prog"><span style="width:${pct.toFixed(1)}%"></span></span>`;
    state = `${fmtDur(x.pos)} of ${fmtDur(x.dur)}`;
    acts = `<button class="vod-act" data-cgo="${i}" title="Carry on where you stopped">Resume</button>`;
  } else {
    const at = x.startedAt ? (x.at - x.startedAt) / 1000 : 0;
    const thumbUrl = live ? live.thumb : x.thumb;
    thumb = `${thumbUrl ? `<img src="${esc(thumbUrl)}" alt="" loading="lazy" data-drop>` : ''}${live ? '<span class="tw-badge">LIVE</span>' : '<span class="vod-dur">ended</span>'}`;
    state = `left ${at ? `at ${fmtDur(at)}` : ''}, ${live ? 'still live' : 'stream ended'}`;
    acts = `${live ? `<button class="vod-act" data-crejoin="${i}" title="Back to the live stream">Rejoin live</button>` : ''}<button class="vod-act" data-cgo="${i}" title="Play the recording from a little before you left">${live ? 'Catch up' : 'Resume'}</button>`;
  }
  return `<div class="vod cont ${playing ? 'playing' : ''}" data-ci="${i}" title="${esc(x.title || '')}" role="button" tabindex="0" aria-label="Continue ${esc(x.display || x.login)}: ${esc(x.title || '')}">
    <div class="tw-thumb">${thumb}${playing ? eqHtml() : `<span class="vod-playicon">${icon('play')}</span>`}</div>
    <div class="tw-info">
      <div class="tw-head">${avatarHtml(x, 'tw-av')}<span class="tw-name">${esc(x.display || x.login)}</span><span class="vod-when">${esc(ago(x.at))}</span></div>
      <div class="tw-title">${esc(x.title || '(no title)')}</div>
      <div class="vod-sub"><span class="vod-state">${esc(state)}</span>
        <span class="vod-acts">${acts}<button class="vod-act ico" data-cforget="${i}" title="Remove from Continue" aria-label="Remove ${esc(x.display || x.login)} from Continue">${icon('x')}</button></span></div>
    </div>
  </div>`;
}

function renderContinue(view) {
  const list = S.cont;
  if (!signedIn() && !(list && list.length)) { renderWelcome(view); return; }
  view.innerHTML = !list ? '<div class="empty"><strong>Loading...</strong></div>'
    : !list.length ? '<div class="empty"><strong>Nothing to continue yet.</strong><br><span class="muted small">Past broadcasts you stop partway through, and live streams you watch for a minute or more and then leave, show up here.</span></div>'
      : list.map(contRowHtml).join('');
  if (!list) return;
  const go = (x) => {
    if (x.kind === 'vod') playTwitch({ kind: 'vod', id: x.id, dur: x.dur, login: x.login, display: x.display, avatar: x.avatar, title: x.title, thumb: x.thumb, link: x.url, sub: `resuming at ${fmtDur(x.pos)}` });
    else catchUp(x);
  };
  const rejoin = (x) => { const c = channels().find((ch) => ch.login === x.login && ch.live); if (c) playLive(c); };
  view.querySelectorAll('.vod.cont').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const x = list[+el.dataset.ci];
    // A live stream that is still on: straight back in; otherwise continue the recording.
    if (x.kind === 'live' && channels().some((c) => sameBroadcast(c, x))) rejoin(x); else go(x);
  }));
  view.querySelectorAll('[data-cgo]').forEach((b) => b.addEventListener('click', () => go(list[+b.dataset.cgo])));
  view.querySelectorAll('[data-crejoin]').forEach((b) => b.addEventListener('click', () => rejoin(list[+b.dataset.crejoin])));
  view.querySelectorAll('[data-cforget]').forEach((b) => b.addEventListener('click', async () => {
    const x = list[+b.dataset.cforget];
    const r = await ask('twitch:forget', { kind: x.kind, id: x.id, login: x.login });
    if (!r) return;
    S.cont = S.cont.filter((y) => y !== x);
    renderCounts();
    render();
  }));
}

async function catchUp(x) {
  snack(`Finding ${x.display || x.login}'s recording...`);
  const r = await ask('twitch:catchUp', x);
  if (!r) return;
  if (!r.ok) fail(r, 'Could not find that recording');
  else loadContinue();
}

// ---------- VODs ----------
async function loadVods(refresh = false) {
  if (S.vodsLoading || !signedIn()) return;
  S.vodsLoading = true;
  S.vodsError = null;
  if (refresh) render();
  const r = await ask('twitch:vods', { refresh });
  S.vodsLoading = false;
  if (r && r.ok) S.vods = { at: r.at, list: r.vods };
  else {
    S.vodsError = friendly((r && r.error) || 'Could not load past broadcasts.');
    if (r) snack(S.vodsError, true);
  }
  if (S.tab === 'vods') render();
}

function vodRowHtml(v, live) {
  const p = v.progress;
  const done = !!(p && p.done);
  const pct = done ? 100 : p && p.pos ? Math.min(100, (p.pos / (p.dur || v.dur)) * 100) : 0;
  const state = done ? 'watched' : pct ? `${fmtDur(p.pos)} in` : '';
  const when = new Date(v.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const playing = S.nowPlaying === v.id;
  return `<div class="vod ${done ? 'done' : ''} ${playing ? 'playing' : ''}" data-vod="${esc(v.id)}" title="${esc(v.title)}" role="button" tabindex="0" aria-label="Play ${esc(v.display)}: ${esc(v.title || 'untitled broadcast')}">
    <div class="tw-thumb">${v.thumb || live ? `<img src="${esc(v.thumb || live.thumb)}" alt="" loading="lazy" data-drop>` : ''}${live ? '<span class="tw-badge">LIVE</span>' : ''}<span class="vod-dur">${fmtDur(v.dur)}${live ? '+' : ''}</span>${pct ? `<span class="vod-prog"><span style="width:${pct.toFixed(1)}%"></span></span>` : ''}${playing ? eqHtml() : `<span class="vod-playicon">${icon('play')}</span>`}</div>
    <div class="tw-info">
      <div class="tw-head">${avatarHtml(v, 'tw-av')}<span class="tw-name">${esc(v.display)}</span><span class="vod-when">${esc(when)}</span></div>
      <div class="tw-title">${esc(v.title || '(no title)')}</div>
      <div class="vod-sub">${state ? `<span class="vod-state">${done ? icon('check') : ''}${esc(state)}</span>` : ''}${v.sub ? '<span title="Only subscribers can watch this one">subscribers only</span>' : ''}${v.views ? `<span>${fmtNum(v.views)} views</span>` : ''}
        <span class="vod-acts hover">
          ${pct && !done ? `<button class="vod-act" data-restart="${esc(v.id)}" title="Play from the beginning">Restart</button>` : ''}
          <button class="vod-act" data-mark="${esc(v.id)}" title="${done ? 'Mark as not watched' : 'Mark as watched'}">${done ? 'Mark unwatched' : 'Mark watched'}</button>
          <button class="vod-act ico" data-ext="${esc(v.url)}" title="Open on twitch.tv">${icon('external')}</button>
        </span></div>
    </div>
  </div>`;
}

function filteredVods() {
  const f = S.vodFilter;
  const favs = new Set(S.favourites);
  return (S.vods ? S.vods.list : []).filter((v) =>
    (!f.channel || (f.channel === '*fav' ? favs.has(v.login) : v.login === f.channel)) && (!f.unwatched || !(v.progress && v.progress.done)));
}

function renderVods(view) {
  if (!signedIn()) { renderWelcome(view); return; }
  const chans = channels().slice().sort((a, b) => a.display.localeCompare(b.display));
  const f = S.vodFilter;
  const opts = [['', 'All channels'], ['*fav', 'Favourites'], ...chans.map((c) => [c.login, c.display])]
    .map(([v, l]) => `<option value="${esc(v)}" ${f.channel === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const controls = `<div class="vod-top">
    <select id="vod-chan" aria-label="Show past broadcasts from">${opts}</select>
    <label class="vod-toggle"><input type="checkbox" id="vod-unw" ${f.unwatched ? 'checked' : ''}> Unwatched only</label>
    <button class="btn ghost vod-refresh ${S.vodsLoading ? 'spin' : ''}" id="vod-refresh" title="Check Twitch again" aria-label="Check Twitch again for past broadcasts">${icon('refresh')}</button>
  </div>`;
  let body;
  if (!S.following.length) body = '<div class="empty"><strong>No channels yet.</strong><br>Past broadcasts from the channels you follow show up here.</div>';
  else if (!S.vods && S.vodsError && !S.vodsLoading) body = `<div class="empty"><strong>Could not load past broadcasts.</strong><br><span class="muted small">${esc(S.vodsError)}</span><div class="row center"><button class="btn" id="vod-retry">Try again</button></div></div>`;
  else if (!S.vods) body = `<div class="empty"><strong>Loading past broadcasts...</strong><br>Checking ${S.following.length} channel${S.following.length === 1 ? '' : 's'}.</div>`;
  else {
    const list = filteredVods();
    if (!list.length) {
      const msg = f.unwatched ? 'You have watched everything here.' : f.channel === '*fav' ? (S.favourites.length ? 'Your favourites have no past broadcasts.' : 'You have no favourites yet. Ring the bell on a channel to make it one.') : f.channel ? 'This channel has no past broadcasts.' : 'No past broadcasts found.';
      body = `<div class="empty"><strong>${esc(msg)}</strong><br><span class="muted small">Some channels turn off saving their broadcasts, and Twitch deletes them after a while.</span></div>`;
    }
    else {
      const shown = list.slice(0, S.vodShow);
      // A channel's newest VOD while it is live is the stream still recording: no thumbnail yet, still growing.
      const live = new Map(liveChannels().map((c) => [c.login, c]));
      const seen = new Set();
      let html = '', last = '';
      for (const v of shown) {
        const d = dayLabel(v.createdAt);
        if (d !== last) { html += `<div class="day">${esc(d)}</div>`; last = d; }
        const c = !seen.has(v.login) && live.get(v.login);
        seen.add(v.login);
        html += vodRowHtml(v, c && v.createdAt >= (Date.parse(c.startedAt) || 0) - 15 * 60e3 ? c : null);
      }
      if (list.length > shown.length) html += `<button class="btn ghost vod-more" id="vod-more">Show more (${list.length - shown.length})</button>`;
      body = html;
    }
  }
  view.innerHTML = `${controls}${body}`;
  const retry = $('#vod-retry');
  if (retry) retry.addEventListener('click', () => loadVods(true));
  $('#vod-chan').addEventListener('change', (e) => { f.channel = e.target.value; S.vodShow = 60; render(); });
  $('#vod-unw').addEventListener('change', (e) => { f.unwatched = e.target.checked; S.vodShow = 60; render(); });
  $('#vod-refresh').addEventListener('click', () => loadVods(true));
  const more = $('#vod-more');
  if (more) more.addEventListener('click', () => { S.vodShow += 60; render(); });
  const byId = (id) => S.vods.list.find((v) => v.id === id);
  view.querySelectorAll('.vod').forEach((el) => el.addEventListener('click', (e) => { if (!e.target.closest('button')) playVod(byId(el.dataset.vod)); }));
  view.querySelectorAll('[data-restart]').forEach((b) => b.addEventListener('click', () => playVod(byId(b.dataset.restart), true)));
  view.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', async () => {
    const v = byId(b.dataset.mark);
    const r = await ask('twitch:watched', { id: v.id, done: !(v.progress && v.progress.done) });
    if (!r) return;
    v.progress = r.progress;
    render();
  }));
  view.querySelectorAll('[data-ext]').forEach((b) => b.addEventListener('click', () => open(b.dataset.ext)));
}

// ---------- Schedule: what followed channels have planned ----------
async function loadSchedule(force = false) {
  if (S.schedLoading || !signedIn()) return;
  S.schedLoading = true;
  if (S.tab === 'schedule' && !S.settingsOpen) render();
  const r = await ask('schedule:get', { force });
  S.schedLoading = false;
  if (r && r.error) fail(r, 'Could not load schedules');
  S.sched = r || S.sched || { items: [], remind: [], failed: true };
  if (S.tab === 'schedule' && !S.settingsOpen) render();
}

function renderSchedule(view) {
  if (!signedIn()) { renderWelcome(view); return; }
  const d = S.sched;
  const top = `<div class="vod-top"><span class="muted small">${d && d.at ? `Next 7 days, from each channel's Twitch schedule. Checked ${ago(d.at)}.` : 'Each channel\'s Twitch schedule for the next 7 days.'}${d && d.paused ? ' Checking is paused.' : ''}</span><button class="btn ghost vod-refresh ${S.schedLoading ? 'spin' : ''}" id="sched-refresh" title="Check Twitch again" aria-label="Check Twitch again for schedules">${icon('refresh')}</button></div>`;
  if (!S.following.length) { view.innerHTML = `${top}<div class="empty"><strong>No channels yet.</strong><br>Streams that the channels you follow have scheduled show up here.</div>`; bindSched(view); return; }
  if (!d) { view.innerHTML = `${top}<div class="empty"><strong>Loading schedules...</strong></div>`; bindSched(view); return; }
  const fav = new Set(S.favourites);
  const remind = new Set(d.remind || []);
  const live = new Map(liveChannels().map((c) => [c.login, c]));
  const items = (d.items || []).filter((it) => (it.end || it.start + 3600e3) > Date.now());
  let html = '', last = '';
  for (const it of items) {
    const day = dayLabel(it.start);
    if (day !== last) { html += `<div class="day">${esc(day)}</div>`; last = day; }
    const isFav = fav.has(it.login);
    const on = isFav || remind.has(it.id);
    const now = live.get(it.login) && it.start <= Date.now() + 30 * 60e3;
    html += `<div class="sched ${isFav ? 'fav' : ''}" data-login="${esc(it.login)}">
      <div class="sched-time"><strong>${esc(new Date(it.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</strong>${it.end ? `<span>${esc(fmtSpan(it.end - it.start))}</span>` : ''}</div>
      ${avatarHtml(it, 'tw-av')}
      <div class="sched-main"><div class="tw-head"><span class="tw-name">${esc(it.display)}</span>${now ? '<span class="tw-pill live">live now</span>' : ''}</div>
        <div class="sched-title">${esc(it.title || 'Scheduled stream')}</div>${it.game ? `<div class="sched-game">${esc(it.game)}</div>` : ''}</div>
      <button class="tw-bell ${on ? 'on' : ''}" data-remind="${esc(it.id)}" ${isFav ? 'disabled' : ''} title="${isFav ? 'Favourites are always reminded' : on ? 'Reminder on. Click to turn it off.' : 'Remind me before it starts'}" aria-pressed="${on ? 'true' : 'false'}">${icon(on ? 'bell' : 'belloff')}</button>
    </div>`;
  }
  view.innerHTML = top + (html || (d.failed ? '<div class="empty"><strong>Could not load schedules.</strong><br><span class="muted small">Press the refresh button to try again.</span></div>' : '<div class="empty"><strong>Nothing scheduled in the next 7 days.</strong><br><span class="muted small">Only channels that fill in their schedule on Twitch show up here.</span></div>'));
  bindSched(view);
}

function bindSched(view) {
  const r = $('#sched-refresh');
  if (r) r.addEventListener('click', () => loadSchedule(true));
  view.querySelectorAll('[data-remind]').forEach((b) => b.addEventListener('click', async () => {
    const on = !b.classList.contains('on');
    const r = await ask('schedule:remind', { id: b.dataset.remind, on });
    if (!r) return;
    S.sched.remind = r;
    render();
    snack(on ? 'Reminder on' : 'Reminder off');
  }));
  view.querySelectorAll('.sched').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const c = liveChannels().find((x) => x.login === el.dataset.login);
    if (c) playLive(c);
  }));
}

// ---------- watch stats (top of Channels) ----------
async function loadStats() {
  S.stats = (await ask('stats:get')) || { days: {} };
  if (S.tab === 'channels' && !S.settingsOpen) render();
}
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (sec) => { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
function weekStats() {
  const days = (S.stats && S.stats.days) || {};
  const out = { days: [], total: 0, per: {} };
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const row = days[dayKey(d)] || {};
    const sum = Object.values(row).reduce((a, b) => a + b, 0);
    out.days.push({ label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), sum });
    out.total += sum;
    for (const [l, s] of Object.entries(row)) out.per[l] = (out.per[l] || 0) + s;
  }
  return out;
}
function statsHtml() {
  const w = weekStats();
  if (!w.total) return '<div class="panel stats"><div class="stats-head"><strong>Watch time</strong><span class="muted small">Nothing watched in the last 7 days yet.</span></div></div>';
  const max = Math.max(...w.days.map((d) => d.sum), 1);
  const names = new Map(channels().map((c) => [c.login, c.display]));
  const top = Object.entries(w.per).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `<div class="panel stats">
    <div class="stats-head"><strong>Watch time</strong><span class="muted small">last 7 days: <strong class="stats-total">${hm(w.total)}</strong></span></div>
    <div class="stats-body">
      <div class="bars">${w.days.map((d) => `<div class="bar" title="${hm(d.sum)}"><i style="height:${Math.max(3, (d.sum / max) * 100)}%"></i><span>${esc(d.label)}</span></div>`).join('')}</div>
      <ol class="stats-top">${top.map(([l, s]) => `<li><span>${esc(names.get(l) || l)}</span><span class="muted">${hm(s)}</span></li>`).join('')}</ol>
    </div></div>`;
}

// ---------- Channels: who you follow ----------
function renderChannels(view) {
  if (!signedIn()) { renderWelcome(view); return; }
  const byLogin = new Map(channels().map((c) => [c.login, c]));
  const fav = new Set(S.favourites);
  const q = S.chanFilter.trim().toLowerCase();
  const rows = S.following
    .map((l) => byLogin.get(l) || { login: l, display: l, avatar: null, live: false })
    .filter((c) => !q || c.login.includes(q) || String(c.display).toLowerCase().includes(q))
    .sort((a, b) => (fav.has(b.login) ? 1 : 0) - (fav.has(a.login) ? 1 : 0) || String(a.display).localeCompare(String(b.display)));
  if (!S.stats) loadStats();
  const none = !S.following.length
    ? '<div class="empty small-empty"><strong>No channels yet.</strong><br>Add one above, or press "Sync with who I follow on Twitch".</div>'
    : '<div class="empty small-empty">No channels match that filter.</div>';
  view.innerHTML = `${statsHtml()}
    <div class="panel add-panel">
      <div class="row"><input type="text" id="chan-add" aria-label="Channels to add" placeholder="Add channels: names or twitch.tv links, separated by spaces or commas" /><button class="btn primary" id="chan-add-btn">${icon('plus')} Add</button></div>
      <div class="row"><button class="btn ghost tiny" id="chan-sync">Sync with who I follow on Twitch</button><span class="muted small">Adds channels you follow on Twitch. It never removes any.</span></div>
    </div>
    ${S.following.length ? `<div class="chan-top"><input type="text" id="chan-filter" aria-label="Filter channels" placeholder="Filter ${S.following.length} channel${S.following.length === 1 ? '' : 's'}" value="${esc(S.chanFilter)}" /></div>` : ''}
    <div class="chan-list">${rows.map((c) => `
      <div class="chan ${c.live ? 'is-live' : ''}" data-login="${esc(c.login)}" ${c.live ? `role="button" tabindex="0" aria-label="Watch ${esc(c.display)} live" title="Watch ${esc(c.display)}"` : ''}>
        ${avatarHtml(c, 'tw-av')}
        <div class="chan-main"><span class="tw-name">${esc(c.display)}</span><span class="chan-sub">${c.live ? `<span class="live-dot"></span>live${c.game ? ` - ${esc(c.game)}` : ''}` : c.lastEndedAt ? `last live ${esc(ago(c.lastEndedAt))}` : esc(c.game || '')}</span></div>
        ${keepHtml(c)}${bellHtml({ ...c, toast: fav.has(c.login) })}
        ${vodBtnHtml(c)}
        <button class="chan-rm" data-rm="${esc(c.login)}" title="Remove from this app" aria-label="Remove ${esc(c.display)} from this app">${icon('trash')}</button>
      </div>`).join('') || none}
    </div>`;
  const input = $('#chan-add');
  const add = async () => {
    const text = input.value.trim();
    if (!text) { snack('Type a channel name or a twitch.tv link first.', true); return; }
    $('#chan-add-btn').disabled = true;
    const r = await ask('channels:add', text);
    // Adding redraws the list (channels:changed), so look the elements up again; they are gone if the tab changed.
    const btn = $('#chan-add-btn'), box = $('#chan-add');
    if (btn) btn.disabled = false;
    if (!r) return;
    if (!r.ok) { fail(r, 'Could not add that channel'); return; }
    if (box) box.value = '';
    snack(`Added ${r.added.map((u) => u.display).join(', ')}${r.unknown.length ? `. Not found on Twitch: ${r.unknown.join(', ')}` : ''}`, !!r.unknown.length);
  };
  $('#chan-add-btn').addEventListener('click', add);
  $('#chan-sync').addEventListener('click', syncFollows);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const filter = $('#chan-filter');
  if (filter) filter.addEventListener('input', (e) => {
    S.chanFilter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const f = $('#chan-filter'); f.focus(); f.setSelectionRange(pos, pos);
  });
  view.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    const login = b.dataset.rm;
    const back = S.settings.syncFollows !== false ? ' If you still follow them there, follow sync will add them back unless you turn it off in Settings.' : '';
    if (!confirm(`Remove ${login} from Twitch Desktop?\n\nThis does not unfollow them on Twitch.${back}`)) return;
    if (await ask('channels:remove', login)) snack(`Removed ${login}`);
  }));
  view.querySelectorAll('.tw-vodbtn').forEach((b) => b.addEventListener('click', () => { S.vodFilter.channel = b.dataset.vods; S.vodShow = 60; setTab('vods'); }));
  view.querySelectorAll('.chan.is-live').forEach((el) => el.addEventListener('click', (e) => { if (!e.target.closest('button')) playLive(byLogin.get(el.dataset.login)); }));
  bindRowButtons(view);
}

// ---------- Twitch account ----------
function renderAccount() {
  const a = S.auth;
  const box = $('#account');
  if (a.signedIn && a.user) {
    box.innerHTML = `<div class="acct">${avatarHtml(a.user, 'acct-av')}<div class="acct-main"><strong>${esc(a.user.display)}</strong><span class="muted small">Signed in: your follows come in, you can chat, and the player uses your account (subscriber-only VODs; Twitch applies your subs and Turbo).</span></div></div>
      <div class="row"><button class="btn" id="acct-sync">Sync follows now</button><button class="btn ghost" id="acct-out">Sign out</button></div>`;
    $('#acct-sync').addEventListener('click', syncFollows);
    $('#acct-out').addEventListener('click', async () => {
      if (!confirm('Sign out of Twitch?\n\nThis removes the sign-in from this app and the player. Your channels and watch history stay.')) return;
      const r = await ask('auth:signOut');
      if (r) S.auth = r;
      renderAccount();
    });
  } else if (!S.setup.clientId) {
    box.innerHTML = `<p class="small"><strong>This build has no Twitch client ID, so it cannot sign in.</strong></p>
      <p class="muted small">Building from source? Set the <code>TWITCH_CLIENT_ID</code> environment variable, or fill in <code>BUILT_IN_CLIENT_ID</code> in <code>src/main/config.js</code>, then restart. Downloaded a release? Please <a href="${REPO}/issues">report it on GitHub</a>.</p>`;
  } else if (a.pending) {
    box.innerHTML = `<p class="small">A Twitch sign-in window is open. Log in if asked, check the code matches, then press <strong>Activate</strong>. Your code: <code class="code">${esc(a.pending.code)}</code></p>
      <div class="row"><span class="spinner" aria-hidden="true"></span><span class="muted small">Waiting for Twitch...</span><button class="btn ghost tiny" id="acct-cancel">Cancel</button></div>`;
    $('#acct-cancel').addEventListener('click', cancelSignIn);
  } else {
    box.innerHTML = `<p class="muted small">Sign in to see who you follow. It also lets you chat, and the player uses your account (subscriber-only VODs; Twitch applies your subs and Turbo). Your sign-in stays on this computer.</p>
      <div class="row"><button class="btn primary" id="acct-in">${icon('twitch')} Sign in with Twitch</button></div>`;
    $('#acct-in').addEventListener('click', signIn);
  }
}

async function syncFollows() {
  snack('Checking who you follow on Twitch...');
  const r = await ask('follows:sync');
  if (!r) return;
  if (!r.ok) { fail(r, 'Could not check who you follow'); return; }
  snack(r.added.length ? `Added ${r.added.length} channel${r.added.length === 1 ? '' : 's'} you follow on Twitch` : `Up to date: you follow ${r.total} channel${r.total === 1 ? '' : 's'} on Twitch`);
}

// ---------- settings ----------
function renderSettings() {
  renderAccount();
  document.querySelectorAll('[data-setting]').forEach((el) => { el.checked = !!S.settings[el.dataset.setting]; });
  document.querySelectorAll('[data-setting-num]').forEach((el) => { if (document.activeElement !== el) el.value = S.settings[el.dataset.settingNum] == null ? '' : S.settings[el.dataset.settingNum]; });
  document.querySelectorAll('[data-setting-text]').forEach((el) => { if (document.activeElement !== el) el.value = S.settings[el.dataset.settingText] || ''; });
  $('#ai-model').placeholder = `Default: ${S.setup.openrouterModel}`;
  $('#ai-hint').hidden = !S.settings.chatRecap || !!String(S.settings.openrouterKey || '').trim();
  $('#about-version').textContent = `Version ${S.setup.version}`;
  renderLog();
}

function renderLog() {
  const el = $('#log');
  el.innerHTML = S.log.length
    ? S.log.slice(-80).map((l) => `<div class="${l.level}">${new Date(l.ts).toLocaleTimeString()} [${esc(l.scope)}] ${esc(l.msg)}</div>`).join('')
    : '<div class="muted">Nothing yet.</div>';
  el.scrollTop = el.scrollHeight;
}

function renderChrome() {
  const off = !!S.settings.paused;
  const b = $('#btn-power');
  b.classList.toggle('off', off);
  b.title = off ? 'Resume checking' : 'Pause checking (stops all requests to Twitch)';
  b.setAttribute('aria-pressed', off ? 'true' : 'false');
  $('#paused-bar').hidden = !off;
  $('#btn-refresh').disabled = off;
  document.documentElement.classList.toggle('paused', off);
  const pin = $('#btn-pin');
  pin.classList.toggle('active', !!S.settings.alwaysOnTop);
  pin.setAttribute('aria-pressed', S.settings.alwaysOnTop ? 'true' : 'false');
  const st = $('#btn-settings');
  st.classList.toggle('active', S.settingsOpen);
  st.setAttribute('aria-pressed', S.settingsOpen ? 'true' : 'false');
  $('#btn-close').title = S.settings.closeToTray === false ? 'Quit' : 'Hide to tray (keeps checking in the background)';
}

function renderCounts() {
  const live = liveChannels().length;
  $('#count-live').textContent = live || '';
  $('#count-continue').textContent = S.cont && S.cont.length ? S.cont.length : '';
  const pill = $('#live-pill');
  pill.hidden = !live;
  pill.textContent = `${live} live`;
}

// ---------- master render ----------
function render() {
  $('#view').hidden = S.settingsOpen;
  $('#view-settings').hidden = !S.settingsOpen;
  $('#tabs').classList.toggle('dim', S.settingsOpen);
  document.querySelectorAll('.tab').forEach((t) => {
    const on = !S.settingsOpen && t.dataset.tab === S.tab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderChrome();
  renderCounts();
  if (S.settingsOpen) { renderSettings(); return; }
  const view = $('#view');
  const scroll = view.scrollTop;
  ({ live: renderLive, continue: renderContinue, vods: renderVods, schedule: renderSchedule, channels: renderChannels })[S.tab](view);
  view.scrollTop = scroll;
}

function setTab(tab) {
  S.tab = tab;
  S.settingsOpen = false;
  $('#view').scrollTop = 0;
  render();
  if (tab === 'vods' && !S.vods) loadVods();
  if (tab === 'continue') loadContinue();
  if (tab === 'schedule') loadSchedule();
  if (tab === 'channels' && signedIn()) loadStats();
}

function tickUptimes() {
  const now = Date.now();
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtSpan(now - Number(el.dataset.since)); });
}

// Broken images fall back to a placeholder (data-ph) or disappear (data-drop). Done here rather than with
// inline onerror handlers, which the page's Content Security Policy blocks.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.dataset.ph) img.replaceWith(Object.assign(document.createElement('span'), { className: `${img.className} ph`, innerHTML: img.dataset.ph }));
  else if ('drop' in img.dataset) img.remove();
}, true);

// Links (anywhere in the window) open in the system browser, never inside the app.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(a.href)) open(a.href);
});

// Clickable rows (role="button" on a div) work from the keyboard too: Enter or Space.
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.target.getAttribute('role') !== 'button') return;
  e.preventDefault();
  e.target.click();
});

async function togglePower() {
  const v = await ask('app:pause', !S.settings.paused);
  if (v == null) return;
  S.settings.paused = v;
  if (S.settingsOpen) renderChrome(); else render();
  snack(v ? 'Paused: nothing is sent to Twitch until you resume' : 'Resumed: checking your channels again');
}

// ---------- events from main ----------
function wireEvents() {
  tw.on('ui:view', (v) => {
    if (v === 'settings') { S.settingsOpen = true; render(); return; }
    if (['live', 'continue', 'vods', 'schedule', 'channels'].includes(v)) setTab(v);
  });
  tw.on('twitch:nowPlaying', (key) => {
    if (key === S.nowPlaying) return;
    S.nowPlaying = key;
    render();
    setTimeout(loadContinue, 1500); // what was just left may now be in Continue
  });
  tw.on('twitch:progress', ({ id, progress }) => {
    const v = S.vods && S.vods.list.find((x) => x.id === id);
    if (!v) return;
    v.progress = progress;
    if (S.tab === 'vods' && !S.settingsOpen) render();
  });
  tw.on('status', (st) => {
    const sig = JSON.stringify([st.channels, !!st.needsSignIn]);
    S.status = st;
    $('#btn-refresh').classList.toggle('spinning', !!st.polling);
    if (sig === S.sig) return; // nothing new to draw
    S.sig = sig;
    if (S.settingsOpen || S.tab === 'vods') renderCounts(); else render();
  });
  tw.on('channels:changed', ({ following, favourites }) => { S.following = following; S.favourites = favourites; if (!S.settingsOpen) render(); });
  tw.on('settings:changed', (s) => { S.settings = s; renderChrome(); if (S.settingsOpen) renderSettings(); });
  tw.on('auth:changed', (a) => {
    const was = signedIn();
    S.auth = a;
    if (a.error && !/cancelled|window closed/i.test(a.error)) snack(friendly(a.error), true);
    else if (a.signedIn && a.user && !was) snack(`Signed in as ${a.user.display}. Bringing in the channels you follow...`);
    if (!was && signedIn()) {
      // Freshly signed in: fetch what the signed-out tabs skipped.
      S.vods = null; S.vodsError = null; S.sched = null; S.stats = null;
      if (S.tab === 'vods') loadVods();
      if (S.tab === 'schedule') loadSchedule();
      loadContinue();
    }
    if (S.settingsOpen) renderAccount(); else render();
  });
  tw.on('log', (line) => { S.log.push(line); if (S.log.length > 300) S.log.shift(); if (S.settingsOpen) renderLog(); });
}

// ---------- UI wiring ----------
function wireUi() {
  document.querySelectorAll('.icon-btn[data-icon]').forEach((b) => { b.innerHTML = icon(b.dataset.icon); });
  $('#btn-min').addEventListener('click', () => ask('window:minimize'));
  $('#btn-close').addEventListener('click', () => ask(S.settings.closeToTray === false ? 'window:quit' : 'window:hide'));
  $('#btn-pin').addEventListener('click', async () => {
    const v = await ask('window:pin', !S.settings.alwaysOnTop);
    if (v != null) S.settings.alwaysOnTop = v;
    renderChrome();
  });
  $('#btn-power').addEventListener('click', togglePower);
  $('#paused-resume').addEventListener('click', togglePower);
  $('#btn-refresh').addEventListener('click', () => {
    if (S.settings.paused) { snack('The app is paused. Resume it first (power button).', true); return; }
    if (!signedIn()) { snack('Sign in with Twitch first.', true); return; }
    ask('poll:now');
  });
  $('#btn-settings').addEventListener('click', () => { S.settingsOpen = !S.settingsOpen; render(); });
  $('#settings-back').addEventListener('click', () => { S.settingsOpen = false; render(); });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  const save = async (patch, msg) => {
    const r = await ask('settings:update', patch);
    if (!r) return;
    S.settings = r;
    if (S.settingsOpen) renderSettings();
    if (msg) snack(msg);
  };
  document.querySelectorAll('[data-setting]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.setting]: el.checked })));
  document.querySelectorAll('[data-setting-num]').forEach((el) => el.addEventListener('change', () => {
    const v = Number(el.value);
    const min = Number(el.min) || 1, max = Number(el.max) || Infinity;
    if (!(v >= min && v <= max)) { snack(`Enter a number${max < Infinity ? ` from ${min} to ${max}` : ` of at least ${min}`}.`, true); return; }
    save({ [el.dataset.settingNum]: v }, 'Saved');
  }));
  document.querySelectorAll('[data-setting-text]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.settingText]: el.value.trim() }, 'Saved')));
  $('#ntfy-test').addEventListener('click', async () => {
    if (!String(S.settings.ntfyTopic || '').trim()) { snack('Enter a topic first.', true); return; }
    if (await ask('ntfy:test')) snack('Test sent to your phone (and as a notification here)');
  });
  const keyBox = $('#ai-key'), keyShow = $('#ai-key-show');
  keyShow.addEventListener('click', () => {
    const show = keyBox.type === 'password';
    keyBox.type = show ? 'text' : 'password';
    keyShow.textContent = show ? 'Hide' : 'Show';
    keyShow.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
  });
  $('#btn-open-data').addEventListener('click', () => ask('open:data'));
}

// ---------- boot ----------
(async function boot() {
  let b;
  try { b = await tw.invoke('app:bootstrap'); } catch (e) {
    $('#view').innerHTML = `<div class="empty"><strong>Twitch Desktop could not start.</strong><br><span class="muted small">${esc(friendly(e.message))}</span></div>`;
    return;
  }
  Object.assign(S, { settings: b.settings, favourites: b.favourites, following: b.following, status: b.status, log: b.log, auth: b.auth, setup: b.setup });
  S.nowPlaying = await ask('twitch:nowPlaying');
  wireUi();
  wireEvents();
  render();
  loadContinue();
  setInterval(tickUptimes, 30000);
})();
