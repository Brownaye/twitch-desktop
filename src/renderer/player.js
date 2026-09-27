/* global pl */
'use strict';
// Docked Twitch player. Switching streams: the old frame is snapshotted and flies off, a card for the new
// stream slides in underneath, and once the new video is actually playing it is revealed with an iris wipe.
// Each stream gets its own <webview>. The one you switch away from stays loaded out of sight (live: playing
// muted; VOD: paused) for WARM_MS, so going back to it is instant instead of reconnecting.

const WARM_MS = 90 * 1000;
const MAX_WARM = 3;      // background streams kept at once (each one is a full video download)

const $ = (id) => document.getElementById(id);
const stage = $('stage');
let current = null;
let token = 0;
let loadedOnce = false;
const views = new Map(); // key -> { key, kind, wv, ready, timer, parkedAt }
let active = null;       // the view on screen
let kept = new Set();    // keys of "keep active" channels: loaded in the background for as long as they are live

const js = (v, code) => v.ready.then(() => v.wv.executeJavaScript(code)).catch(() => null);
const mute = (v, on) => v.ready.then(() => v.wv.setAudioMuted(on)).catch(() => {});

// Twitch's embed keeps its player object on the React tree; this finds it (cached per page) so quality, volume
// and pause can be set directly. withCore runs `body` (with the player as `c`) once it is up, trying for 20 s;
// body must `return` something to stop.
const CORE = `(() => { if (window.__tdCore) return window.__tdCore; const el = document.querySelector('.video-player'); if (!el) return null;
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber')); let f = key && el[key];
  for (let i = 0; f && i < 200; i++, f = f.return) { const p = f.memoizedProps || {}; if (p.mediaPlayerInstance) { window.__tdCore = p.mediaPlayerInstance.core || p.mediaPlayerInstance; return window.__tdCore; } }
  return null; })()`;
const withCore = (v, body) => js(v, `(async () => { for (let i = 0; i < 40; i++) { const c = ${CORE};
  if (c && c.getQualities && c.getQualities().length) { ${body} } await new Promise((r) => setTimeout(r, 500)); } return null; })()`);
// setQuality(q, true) switches at the next segment; without `true` (and setAutoQualityMode) Twitch throws the buffer
// away and the video goes black for seconds, which is exactly what keeping a stream loaded is meant to avoid.
const Q_LOW = 'window.__tdWant = "low"; const qs = c.getQualities(); c.setQuality(qs[qs.length - 1], true); return true;';
// Back on screen: straight up to the best quality (automatic mode would climb slowly from 160p), then automatic
// once the buffer holds good segments (turning it on right away would drop the buffer).
const Q_AUTO = `window.__tdWant = 'auto'; if (c.isAutoQualityMode()) return true;
  c.setQuality(c.getQualities()[0], true);
  setTimeout(() => { if (window.__tdWant === 'auto') c.setAutoQualityMode(true); }, 8000); return true;`;
// Out of sight while only a few streams are: the best at or under 720p, so switching shows a good picture at once.
const Q_MID = 'window.__tdWant = "mid"; const qs = c.getQualities(); c.setQuality(qs.find((q) => q.height && q.height <= 720) || qs[qs.length - 1], true); return true;';
const BG_MID_MAX = 3;    // up to this many live streams out of sight play at 720p; more than that, all at 160p
// Multi-view tiles: the best quality at or under 360p.
const Q_TILE = 'window.__tdWant = "tile"; const qs = c.getQualities(); c.setQuality(qs.find((q) => q.height && q.height <= 360) || qs[qs.length - 1], true); return true;';

let prefs = { bgLow: true, audio: false, volumes: {} };
let grid = false;

// What quality a view should play at: audio mode for the one on screen, 360p tiles in multi-view; out of sight
// (when that setting is on) 720p while there are at most BG_MID_MAX live streams there, else the lowest;
// otherwise Twitch's automatic choice.
const QS = { low: Q_LOW, mid: Q_MID, tile: Q_TILE, auto: Q_AUTO };
function bgWant(v) {
  if (grid && v.tile) return 'tile';
  if (!prefs.bgLow) return 'auto';
  const out = [...views.values()].filter((w) => w !== active && w.kind === 'live').length;
  return out <= BG_MID_MAX ? 'mid' : 'low';
}
function applyQuality(v, on = v === active) {
  if (!v) return;
  if (on) { v.bg = null; withCore(v, prefs.audio ? Q_LOW : Q_AUTO); return; }
  v.bg = bgWant(v);
  withCore(v, QS[v.bg]);
}
// Streams out of sight come and go: move the rest between 720p and 160p when the count crosses BG_MID_MAX.
function rebalance() {
  for (const v of views.values()) if (v !== active && v.bg !== bgWant(v)) applyQuality(v, false);
}
function applyVolume(v) {
  const vol = v && v.login && prefs.volumes[v.login];
  if (vol != null) withCore(v, `c.setVolume(${Number(vol)}); return true;`);
}

function makeView(key, kind, dur) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:twitch-player');
  stage.insertBefore(wv, $('snap'));
  const v = { key, kind, dur, wv, timer: null, parkedAt: 0, login: null, meta: null };
  v.ready = new Promise((r) => wv.addEventListener('dom-ready', r, { once: true }));
  if (kind === 'vod') {
    wv.addEventListener('dom-ready', () => armSkip(v)); // again after any reload of the page
    wv.addEventListener('console-message', (e) => {
      if (!String(e.message).startsWith('[skm] ')) return;
      try { const { from, to } = JSON.parse(e.message.slice(6)); if (v === active) skipFx(v, from, to); } catch { /* not ours */ }
    });
  }
  views.set(key, v);
  return v;
}

function drop(v) {
  clearTimeout(v.timer);
  v.wv.remove();
  views.delete(v.key);
  if (active === v) active = null;
  rebalance();
}

// Move the on-screen stream to the background and start its countdown.
function park(v) {
  v.wv.classList.remove('active');
  v.wv.classList.add('warm');
  mute(v, true);
  if (v.kind === 'vod') js(v, `(() => { const x = document.querySelector('video'); if (x) x.pause(); })()`);
  v.parkedAt = Date.now();
  clearTimeout(v.timer);
  v.timer = kept.has(v.key) || grid ? null : setTimeout(() => drop(v), WARM_MS);
  trimWarm();
  applyQuality(v, false); // it is still `active` until the next one takes over
}

// Kept channels do not count towards MAX_WARM and never time out.
function trimWarm() {
  if (grid) return; // multi-view keeps its tiles
  const warm = [...views.values()].filter((w) => w.parkedAt && !kept.has(w.key)).sort((a, b) => a.parkedAt - b.parkedAt);
  while (warm.length > MAX_WARM) drop(warm.shift());
}

// Start a kept channel out of sight (the main process mutes every new stream).
function preload(key, url, meta) {
  const v = makeView(key, 'live');
  v.meta = meta || null;
  v.login = meta ? meta.login : key.replace(/^live:/, '');
  v.wv.classList.add('warm');
  v.parkedAt = Date.now();
  v.wv.src = url;
  applyQuality(v);
  applyVolume(v);
  rebalance();
  if (grid) layoutGrid();
}

pl.on('player:keep', (list) => {
  const next = new Set(list.map((k) => k.key));
  // No longer kept (switched off, or the channel went offline): back to the normal countdown.
  for (const key of kept) {
    const v = views.get(key);
    if (!next.has(key) && v && v !== active) { clearTimeout(v.timer); v.timer = setTimeout(() => drop(v), WARM_MS); }
  }
  kept = next;
  for (const { key, url, meta } of list) {
    const v = views.get(key);
    if (!v) preload(key, url, meta);
    else clearTimeout(v.timer);
  }
  trimWarm();
});

function activate(v) {
  clearTimeout(v.timer);
  v.parkedAt = 0;
  v.wv.classList.remove('warm');
  v.wv.classList.add('active');
  active = v;
  mute(v, false);
  if (v.kind === 'vod') js(v, `(() => { const x = document.querySelector('video'); if (x) x.play(); })()`);
  v.ready.then(() => pl.invoke('player:active', v.wv.getWebContentsId())).catch(() => {});
  applyQuality(v);
  applyVolume(v);
  rebalance();
  renderAudio();
  if (grid) layoutGrid();
}

function avatar(el, meta) {
  el.innerHTML = '';
  if (meta.avatar) el.appendChild(Object.assign(document.createElement('img'), { src: meta.avatar, alt: '' }));
  else el.textContent = (meta.display || '?').slice(0, 1).toUpperCase();
}

function fill(meta) {
  const live = meta.kind === 'live';
  for (const [av, name, title, badge, info] of [['h-av', 'h-name', 'h-title', 'h-badge', 'h-meta'], ['c-av', 'c-name', 'c-title', 'c-badge', 'c-meta']]) {
    avatar($(av), meta);
    $(name).textContent = meta.display || '';
    $(title).textContent = meta.title || '';
    $(badge).textContent = live ? 'LIVE' : 'VOD';
    $(badge).className = `badge ${live ? 'live' : 'vod'}`;
    $(info).textContent = meta.sub || '';
  }
  $('card-bg').style.backgroundImage = meta.thumb ? `url("${meta.thumb.replace(/"/g, '%22')}")` : 'none';
  document.title = `${meta.display}: ${meta.title || ''}`;
}

// Fly the outgoing frame off to the left.
async function snapOut() {
  if (grid) return; // tiles just swap sound in multi-view
  const snap = $('snap');
  let url = null;
  try { url = active ? (await active.wv.capturePage()).toDataURL() : null; } catch { /* no frame yet */ }
  if (!url) return;
  snap.style.backgroundImage = `url("${url}")`;
  snap.classList.remove('out');
  void snap.offsetWidth; // restart the animation
  snap.classList.add('show', 'out');
  setTimeout(() => snap.classList.remove('show', 'out'), 650);
}

async function isPlaying(v) {
  try {
    return await v.wv.executeJavaScript(`(() => { const v = document.querySelector('video'); return !!v && v.readyState >= 3 && !v.paused && v.currentTime > 0; })()`);
  } catch { return false; }
}

async function load({ url, meta, key }) {
  key = key || url;
  if (active && active.key === key && !meta.restart) return; // already on screen
  const my = ++token;
  const first = !loadedOnce;
  current = meta;
  if (!first) await snapOut();
  if (my !== token) return;
  fill(meta);
  if (active) park(active);
  let v = views.get(key);
  if (v && meta.restart) { drop(v); v = null; }
  if (v) { v.meta = meta; v.login = meta.login; }
  loadedOnce = true;
  if (first) document.body.classList.add('enter');
  if (v) {
    // Still loaded in the background: straight back in with a quick wipe.
    activate(v);
    stage.classList.remove('revealed', 'revealing');
    stage.classList.add('quick');
    void stage.offsetWidth;
    stage.classList.add('revealing');
    setTimeout(() => { if (my === token) stage.classList.add('revealed'); }, 350);
    return;
  }
  stage.classList.remove('revealed', 'revealing', 'quick');
  const card = $('card');
  card.classList.remove('in');
  void card.offsetWidth;
  card.classList.add('in');
  v = makeView(key, meta.kind, meta.dur);
  v.meta = meta;
  v.login = meta.login;
  activate(v);
  v.wv.src = url;
  // Reveal once frames are flowing (an ad counts), or after 12 s so errors such as "subscribers only" still show.
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 700));
  while (my === token && Date.now() - started < 12000 && !(await isPlaying(v))) await new Promise((r) => setTimeout(r, 250));
  if (my !== token) return;
  stage.classList.add('revealing');
  setTimeout(() => { if (my === token) stage.classList.add('revealed'); }, 700);
}

pl.on('player:load', load);

// ---------- preferences from the main process ----------
pl.on('player:prefs', (p) => {
  const was = prefs;
  prefs = p;
  raidsSocket(!!p.raids);
  if (was.audio !== p.audio || was.bgLow !== p.bgLow) for (const v of views.values()) applyQuality(v);
  renderAudio();
});

// ---------- audio mode ----------
function renderAudio() {
  const on = !!prefs.audio && !!active;
  $('b-audio').classList.toggle('on', !!prefs.audio);
  $('audio-card').hidden = !on;
  document.body.classList.toggle('audio', on);
  if (!on || !current) return;
  avatar($('a-av'), current);
  $('a-name').textContent = current.display || '';
  $('audio-bg').style.backgroundImage = current.thumb ? `url("${current.thumb.replace(/"/g, '%22')}")` : 'none';
}
async function toggleAudio() {
  prefs.audio = await pl.invoke('player:audio', !prefs.audio);
  if (active) applyQuality(active);
  renderAudio();
  ptoast(prefs.audio ? 'Audio mode: lowest quality, picture hidden' : 'Picture back, quality automatic');
}
$('b-audio').addEventListener('click', toggleAudio);
$('audio-card').addEventListener('click', toggleAudio); // clicking the card brings the picture back

// ---------- volume per channel ----------
// The player's own volume slider is Twitch's; every few seconds the one on screen is read and remembered per channel.
let lastVol = null;
setInterval(async () => {
  if (!active || !active.login) return;
  const r = await js(active, `(() => { const c = ${CORE}; return c && c.getVolume ? c.getVolume() : null; })()`);
  if (typeof r !== 'number') return;
  const k = `${active.login}:${r}`;
  if (k === lastVol) return;
  const known = prefs.volumes[active.login];
  lastVol = k;
  if (known === undefined || Math.abs(known - r) > 0.009) { prefs.volumes[active.login] = r; pl.invoke('player:volume', { login: active.login, volume: r }); }
}, 3000);

// ---------- media keys and shortcuts (from the main process) ----------
pl.on('player:key', (k) => {
  if (k === 'g') toggleGrid();
  else if (k === 'playpause' && active) withCore(active, 'if (c.isPaused()) c.play(); else c.pause(); return true;');
  else if (k === 'pause' && active) withCore(active, 'c.pause(); return true;');
});

// ---------- sleep timer ----------
// Counts down in the header; at zero the sound fades out over 20 s and the player closes (a VOD's position and a
// live stream's place in Continue are kept, as with any close). "End of this video" stops where a VOD would
// otherwise carry on into the next part.
let sleepAt = 0;
let sleepEnd = false;
function setSleep(what) {
  $('sleep-menu').hidden = true;
  sleepAt = 0;
  sleepEnd = what === 'end';
  pl.invoke('player:sleepEnd', sleepEnd);
  if (/^\d+$/.test(what)) sleepAt = Date.now() + Number(what) * 60e3;
  renderSleep();
  ptoast(what === 'off' ? 'Sleep timer off' : sleepEnd ? 'Sleep timer: stops at the end of this video' : `Sleep timer: ${what} minutes`);
}
function renderSleep() {
  const on = !!sleepAt || sleepEnd;
  $('b-sleep').classList.toggle('on', on);
  const left = sleepAt ? Math.max(0, sleepAt - Date.now()) : 0;
  $('sleep-left').textContent = sleepEnd ? 'end' : sleepAt ? `${Math.floor(left / 60e3)}:${String(Math.floor((left % 60e3) / 1000)).padStart(2, '0')}` : '';
  $('sleep-end').hidden = !current || current.kind !== 'vod';
}
async function sleepNow() {
  sleepAt = 0; sleepEnd = false;
  renderSleep();
  $('sleep-fade').hidden = false;
  if (active) {
    await withCore(active, `const v0 = c.getVolume(); for (let i = 20; i >= 0; i--) { c.setVolume(v0 * i / 20); await new Promise((r) => setTimeout(r, 1000)); } c.pause(); c.setVolume(v0); return true;`);
  }
  document.body.classList.add('leave');
  setTimeout(() => pl.invoke('player:close'), 220);
}
pl.on('player:sleepNow', sleepNow);
setInterval(() => { if (sleepAt && Date.now() >= sleepAt) sleepNow(); else if (sleepAt) renderSleep(); }, 1000);
$('b-sleep').addEventListener('click', (e) => { e.stopPropagation(); renderSleep(); $('sleep-menu').hidden = !$('sleep-menu').hidden; $('sizes').hidden = true; });
document.querySelectorAll('[data-sleep]').forEach((b) => b.addEventListener('click', () => setSleep(b.dataset.sleep)));

// ---------- chapters (VODs) ----------
let chapterList = [];
pl.on('player:chapters', ({ key, chapters }) => {
  if (!active || active.key !== key) return;
  chapterList = chapters || [];
  $('b-chapters').hidden = chapterList.length < 2;
});
const hms = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };
$('b-chapters').addEventListener('click', async (e) => {
  e.stopPropagation();
  const menu = $('chapters-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  const t = active ? await js(active, `(() => { const v = document.querySelector('video'); return v ? v.currentTime : 0; })()`) : 0;
  const at = chapterList.reduce((i, c, n) => (c.start <= t ? n : i), 0);
  menu.innerHTML = '<div class="sizes-title">Chapters</div>' + chapterList.map((c, i) => `<button data-at="${c.start}" class="${i === at ? 'on' : ''}">${c.art ? `<img class="ch-art" src="${c.art}" alt="">` : '<span class="ch-art"></span>'}<span class="nm">${c.game.replace(/</g, '&lt;')}</span><span class="kb">${hms(c.start)}</span></button>`).join('');
  menu.querySelectorAll('[data-at]').forEach((b) => b.addEventListener('click', () => {
    menu.hidden = true;
    if (active) js(active, `(() => { const v = document.querySelector('video'); if (v) v.currentTime = ${Number(b.dataset.at) + 1}; })()`);
  }));
  menu.hidden = false;
  $('sleep-menu').hidden = true; $('sizes').hidden = true;
});

// ---------- following raids ----------
// Signed in, this page keeps an EventSub WebSocket; the main process subscribes it to channel.raid for the live
// channel on screen. A raid shows a banner that counts down 8 s and then follows (Stay cancels, Go now skips).
let eventSub = null;
let raidRetry = 5000;
let raidTimer = null;
function raidsSocket(on) {
  if (!on) { if (eventSub) { const w = eventSub; eventSub = null; w.onclose = null; w.close(); pl.invoke('raids:session', null); } return; }
  if (eventSub) return;
  const open = (url) => {
    const w = new WebSocket(url);
    w.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const type = m.metadata && m.metadata.message_type;
      if (type === 'session_welcome') pl.invoke('raids:session', m.payload.session.id);
      else if (type === 'session_reconnect') { w.onclose = null; eventSub = open(m.payload.session.reconnect_url); setTimeout(() => w.close(), 3000); }
      else if (type === 'notification' && m.payload.subscription.type === 'channel.raid') onRaid(m.payload.event);
    };
    // Some networks drop long-lived sockets after a few seconds: wait longer after each short-lived connection
    // (up to 5 minutes) instead of reconnecting, and making a new subscription, every few seconds.
    const opened = Date.now();
    w.onclose = () => {
      if (eventSub !== w) return;
      eventSub = null;
      raidRetry = Date.now() - opened > 60e3 ? 5000 : Math.min(raidRetry * 2, 5 * 60e3);
      setTimeout(() => raidsSocket(prefs.raids), raidRetry);
    };
    return w;
  };
  eventSub = open('wss://eventsub.wss.twitch.tv/ws');
}
async function onRaid(ev) {
  if (!current || current.kind !== 'live' || ev.from_broadcaster_user_login !== current.login) return;
  const meta = await pl.invoke('raids:target', ev.to_broadcaster_user_login);
  if (!meta) { ptoast(`${ev.from_broadcaster_user_name} raided ${ev.to_broadcaster_user_name}`); return; }
  $('raid-from').textContent = ev.from_broadcaster_user_name;
  $('raid-to').textContent = ev.to_broadcaster_user_name;
  const fill = $('raid-fill');
  fill.style.transition = 'none'; fill.style.width = '0%';
  $('raid').hidden = false;
  void fill.offsetWidth;
  fill.style.transition = 'width 8s linear'; fill.style.width = '100%';
  const go = () => { clearTimeout(raidTimer); $('raid').hidden = true; pl.invoke('player:play', meta); };
  $('raid-go').onclick = go;
  $('raid-stay').onclick = () => { clearTimeout(raidTimer); $('raid').hidden = true; };
  clearTimeout(raidTimer);
  raidTimer = setTimeout(go, 8000);
}

// ---------- multi-view ----------
// Up to 4 streams at once: the one on screen (with sound) plus the most recent ones kept in the background.
// Clicking a tile makes it the one with sound (and moves chat to it) without reloading anything.
function tiles() {
  const others = [...views.values()].filter((v) => v !== active).sort((a, b) => b.parkedAt - a.parkedAt);
  return [active, ...others].filter(Boolean).slice(0, 4);
}
function layoutGrid() {
  stage.querySelectorAll('.tile-hit').forEach((el) => el.remove());
  for (const v of views.values()) { v.tile = false; v.wv.style.cssText = ''; v.wv.classList.remove('tile', 'tile-on'); }
  if (!grid) return;
  const list = tiles();
  const n = list.length;
  const cells = n <= 1 ? [[0, 0, 100, 100]] : n === 2 ? [[0, 25, 50, 50], [50, 25, 50, 50]] : [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 50, 50], [50, 50, 50, 50]];
  list.forEach((v, i) => {
    const [x, y, w, h] = cells[i];
    v.tile = true;
    v.wv.classList.add('tile');
    v.wv.classList.toggle('tile-on', v === active);
    v.wv.style.cssText = `left:${x}%;top:${y}%;width:${w}%;height:${h}%;`;
    const hit = document.createElement('button');
    hit.className = `tile-hit${v === active ? ' on' : ''}`;
    hit.style.cssText = `left:${x}%;top:${y}%;width:${w}%;height:${h}%;`;
    hit.innerHTML = `<span class="tile-name">${v === active ? '\u{1F50A} ' : ''}${(v.meta && v.meta.display) || v.login || ''}</span>`;
    hit.title = v === active ? 'Playing with sound' : 'Click for sound (and chat)';
    if (v !== active && v.meta) hit.addEventListener('click', () => pl.invoke('player:play', v.meta));
    stage.appendChild(hit);
    applyQuality(v);
  });
}
function toggleGrid() {
  grid = !grid;
  document.body.classList.toggle('grid', grid);
  $('b-grid').classList.toggle('on', grid);
  if (grid) {
    for (const v of views.values()) clearTimeout(v.timer); // tiles stay while multi-view is on
    const n = tiles().length;
    ptoast(n > 1 ? `Multi-view: ${n} streams. Click one for sound` : 'Multi-view: open other streams and they join the grid');
  } else {
    for (const v of views.values()) if (v !== active) { v.timer = kept.has(v.key) ? null : setTimeout(() => drop(v), WARM_MS); }
    trimWarm();
  }
  layoutGrid();
  for (const v of views.values()) applyQuality(v);
}
$('b-grid').addEventListener('click', toggleGrid);

// ---------- skip muted parts of VODs (ported from the Skip Muted for Twitch extension) ----------
// The main process looks up the muted ranges; a small script in the Twitch page jumps past each one as playback
// reaches it and fades the sound back in, and tells this page (console '[skm] {from,to}') to play the transition.
const muted = new Map(); // VOD key -> [{ start, end }]
pl.on('player:muted', ({ key, segments }) => {
  muted.set(key, segments || []);
  const v = views.get(key);
  if (v) armSkip(v);
});

function armSkip(v) {
  const segs = muted.get(v.key);
  if (!segs) return;
  // Pre-roll ads play in the same <video>: only a duration close to the VOD's (or longer, still recording) is it.
  const minDur = v.dur ? v.dur - Math.max(60, v.dur * 0.05) : 0;
  js(v, `(() => {
    if (window.__skm) window.__skm.off();
    const segs = ${JSON.stringify(segs)}, minDur = ${minDur};
    let last = 0, fade = null;
    const fadeIn = (vid, ms) => {
      if (vid.muted) return;
      const target = fade ? fade.target : vid.volume;
      if (fade) clearInterval(fade.timer);
      if (target <= 0) { fade = null; return; }
      vid.volume = 0;
      const t0 = performance.now();
      const timer = setInterval(() => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        vid.volume = target * p * p;
        if (p >= 1) { clearInterval(timer); vid.volume = target; if (fade && fade.timer === timer) fade = null; }
      }, 25);
      fade = { target, timer };
    };
    const on = (e) => {
      const vid = e.target;
      if (!(vid instanceof HTMLVideoElement) || vid.seeking || !isFinite(vid.duration) || vid.duration < minDur) return;
      if (Date.now() - last < 1500) return;
      const t = vid.currentTime;
      for (const s of segs) {
        if (t >= s.start - 0.25 && t < s.end - 0.5) {
          const to = s.end + 0.5;
          if (to >= vid.duration) return; // muted to the end
          last = Date.now();
          console.log('[skm] ' + JSON.stringify({ from: t, to: s.end }));
          vid.currentTime = to;
          fadeIn(vid, 2000);
          return;
        }
      }
    };
    document.addEventListener('timeupdate', on, true); // media events do not bubble, but capture sees them
    window.__skm = { off: () => document.removeEventListener('timeupdate', on, true) };
  })()`);
}

const clock = (sec) => { sec = Math.max(0, Math.floor(sec)); return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
const span = (sec) => { sec = Math.round(sec); const m = Math.floor(sec / 60); return m ? `${m}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`; };

// The fast-forward transition: speed streaks, a pulsing double arrow, a clock rolling to where playback lands.
let fxEl = null;
function skipFx(v, from, to) {
  const FX_MS = 2000;
  if (fxEl) fxEl.remove();
  const el = document.createElement('div');
  el.className = 'skm-fx';
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('div');
    s.className = 'skm-streak';
    s.style.cssText = `top:${Math.random() * 100}%;width:${20 + Math.random() * 30}%;opacity:${0.35 + Math.random() * 0.65};animation-duration:${450 + Math.random() * 450}ms;animation-delay:${-Math.random() * 900}ms`;
    el.appendChild(s);
  }
  el.insertAdjacentHTML('beforeend', `<div class="skm-icon"><svg viewBox="0 0 96 72" fill="#fff"><path d="M4 6 L46 36 L4 66 Z"/><path d="M50 6 L92 36 L50 66 Z"/></svg></div><div class="skm-time">${clock(from)}</div><div class="skm-label">Skipping ${span(to - from)} of muted audio</div>`);
  stage.appendChild(el);
  fxEl = el;
  const time = el.querySelector('.skm-time');
  const t0 = performance.now();
  const roll = (now) => {
    const p = Math.min(1, (now - t0) / (FX_MS * 0.7));
    time.textContent = clock(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1 && el.isConnected) requestAnimationFrame(roll);
  };
  requestAnimationFrame(roll);
  v.wv.classList.add('skm-blur');
  setTimeout(() => v.wv.classList.remove('skm-blur'), FX_MS * 0.75);
  setTimeout(() => { el.remove(); if (fxEl === el) fxEl = null; }, FX_MS + 50);
}

// ---------- watch a live stream from the start ----------
let toastTimer = null;
function ptoast(msg) {
  const t = $('ptoast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
pl.on('player:load', ({ meta }) => {
  $('b-start').hidden = meta.kind !== 'live';
  $('b-chapters').hidden = true; chapterList = []; $('chapters-menu').hidden = true;
  renderSleep();
  if (grid) setTimeout(layoutGrid, 50);
});
pl.on('player:toast', (msg) => ptoast(msg));

// The same VOD again at a later point (it has grown since it was loaded). The last frame stays up while it reloads.
pl.on('player:reload', async ({ key, url }) => {
  const v = views.get(key);
  if (!v || v !== active) return;
  const my = ++token;
  const snap = $('snap');
  try { snap.style.backgroundImage = `url("${(await v.wv.capturePage()).toDataURL()}")`; snap.classList.add('show'); } catch { /* no frame */ }
  v.wv.src = url;
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 1500));
  while (my === token && Date.now() - started < 15000 && !(await isPlaying(v))) await new Promise((r) => setTimeout(r, 250));
  snap.classList.remove('show');
});

$('b-start').addEventListener('click', async () => {
  $('b-start').disabled = true;
  const r = await pl.invoke('player:fromStart');
  $('b-start').disabled = false;
  if (!r || !r.ok) ptoast((r && r.error) || 'Could not find the start of this stream');
});
pl.on('player:pause', () => active && js(active, `(() => { const v = document.querySelector('video'); if (v && !v.paused) v.pause(); })()`));
pl.on('player:resume', () => active && js(active, `(() => { const v = document.querySelector('video'); if (v) v.play(); })()`));

$('b-close').addEventListener('click', () => {
  document.body.classList.add('leave');
  setTimeout(() => pl.invoke('player:close'), 220);
});
$('b-full').addEventListener('click', () => pl.invoke('player:fullscreen'));
$('b-min').addEventListener('click', () => pl.invoke('player:minimize'));
$('b-chat').addEventListener('click', () => pl.invoke('player:chat'));

// Docked beside the app, detached as its own window, or picture in picture (small, always on top).
let mode = 'docked';
function setMode(m) { $('sizes').hidden = true; pl.invoke('player:mode', m); }
pl.on('player:mode', (m) => {
  mode = m;
  for (const k of ['docked', 'detached', 'pip']) document.body.classList.toggle(k, k === m);
  $('b-detach').title = m === 'docked' ? 'Detach from the app (D)' : 'Dock beside the app (D)';
  $('b-pip').title = m === 'pip' ? 'Exit picture in picture (P)' : 'Picture in picture (P)';
  $('b-pip').classList.toggle('on', m === 'pip');
});
// The tab on the edge facing the app slides the app away (and back), leaving just the stream.
let edge = { side: 'right', collapsed: false };
pl.on('player:edge', (e) => {
  edge = e;
  const b = $('b-edge');
  b.classList.toggle('left', e.side === 'left');
  b.classList.toggle('collapsed', !!e.collapsed);
  b.title = e.collapsed ? 'Show the app' : 'Hide the app';
  // Points towards the app to push it away, back out to bring it back.
  $('edge-arrow').setAttribute('points', (e.side === 'right') !== !!e.collapsed ? '9 6 15 12 9 18' : '15 6 9 12 15 18');
});
$('b-edge').addEventListener('click', () => pl.invoke('player:collapse', !edge.collapsed));
// Docked: the header drags the player and the app together (the main process follows the cursor).
const header = document.querySelector('header');
header.addEventListener('pointerdown', (e) => {
  if (mode !== 'docked' || e.button !== 0 || e.target.closest('button, .sizes')) return;
  header.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  pl.invoke('player:drag', 'start');
});
const endDrag = () => {
  if (!document.body.classList.contains('dragging')) return;
  document.body.classList.remove('dragging');
  pl.invoke('player:drag', 'end');
};
header.addEventListener('pointerup', endDrag);
header.addEventListener('pointercancel', endDrag);
header.addEventListener('lostpointercapture', endDrag);
pl.on('player:hover', (on) => document.body.classList.toggle('hover', !!on));
$('b-detach').addEventListener('click', () => setMode(mode === 'docked' ? 'detached' : 'docked'));
$('b-pip').addEventListener('click', () => setMode(mode === 'pip' ? 'unpip' : 'pip'));
pl.on('player:chatState', ({ available, on }) => {
  const b = $('b-chat');
  b.hidden = !available;
  b.classList.toggle('on', !!on);
  b.classList.toggle('off', !on);
  $('b-chat-label').textContent = on ? 'Chat' : 'Show chat';
  b.title = on ? 'Hide live chat' : 'Show live chat';
});

// Size presets. The number keys 1-4 pick one too.
function setSize(size) {
  $('sizes').hidden = true;
  pl.invoke('player:size', size);
}
pl.on('player:sizeState', (size) => document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', b.dataset.size === size)));
$('b-size').addEventListener('click', (e) => { e.stopPropagation(); $('sizes').hidden = !$('sizes').hidden; });
document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => setSize(b.dataset.size)));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.sizes-wrap')) $('sizes').hidden = true;
  if (!e.target.closest('.menu-wrap')) { $('sleep-menu').hidden = true; $('chapters-menu').hidden = true; }
});
const SIZE_KEYS = { 1: 'small', 2: 'medium', 3: 'large', 4: 'max' };
$('b-ext').addEventListener('click', () => current && current.link && pl.invoke('player:external', current.link));
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); pl.invoke('player:fullscreen'); }
  if (e.key === 'Escape') { $('sizes').hidden = true; pl.invoke('player:fullscreen', false); }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (SIZE_KEYS[e.key]) setSize(SIZE_KEYS[e.key]);
  if (e.key.toLowerCase() === 'p') setMode(mode === 'pip' ? 'unpip' : 'pip');
  if (e.key.toLowerCase() === 'd') setMode(mode === 'docked' ? 'detached' : 'docked');
  if (e.key.toLowerCase() === 'g') toggleGrid();
  if (e.key.toLowerCase() === 'n') pl.invoke('player:step', 1);
  if (e.key.toLowerCase() === 'b') pl.invoke('player:step', -1);
});
