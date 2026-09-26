'use strict';
// The Twitch player panel: a frameless window docked to the left edge of the main window (right edge if there is
// no room), moving, hiding and minimising with it. It hosts player.twitch.tv in a <webview> so the page can
// animate between streams. VOD positions are sampled from the <video> every 5 s (see vods.record).
// For live streams a second panel, the chat (src/renderer/livechat.html), docks under the player down to the
// bottom of the main window. settings.playerChat (default on) is toggled from the player header or the chat's X.
// settings.playerMode: 'docked' (above), 'detached' (a free window that stays up when the app is hidden, chat
// follows it; bounds in settings.playerFloat) or 'pip' (small, always on top, no chat, header only on hover;
// bounds in settings.playerPip, and settings.playerBeforePip is the mode to go back to).
const path = require('path');
const { BrowserWindow, screen, shell, webContents, globalShortcut } = require('electron');
const store = require('./store');
const raids = require('./raids');
const config = require('./config');
const vods = require('./vods');
const log = require('./log');
const ai = require('./ai');

const HEADER = 44;       // player.css --header
const GAP = 8;
const MIN_WIDTH = 480;
const DEFAULT_WIDTH = 800;
const CHAT_MIN = 200;     // below this there is no room for the chat panel
const SIZES = { small: 560, medium: 800, large: 1120 }; // 'max' = all the room beside the main window
const PIP_WIDTH = 400;
const PIP_MIN = 240;
const MARGIN = 24;        // PiP distance from the screen corner
const MODES = ['docked', 'detached', 'pip'];

let main = null;         // () => main BrowserWindow
let onProgress = () => {};
let onNowPlaying = () => {};
let player = null;
let guest = null;        // the on-screen webview's webContents (others may be kept warm in the background)
let ready = null;        // resolves when player.html has loaded
let playing = null;      // { kind, key, id?, dur? }
let timer = null;
let docking = false;
let hiddenWithMain = false;
let chat = null;         // the live chat BrowserWindow
let chatReady = null;
let current = null;      // meta of what is playing
let animating = false;
let saveTimer = null;
let hoverTimer = null;
let hovering = false;
let collapsed = false;   // the app was slid away with the tab on the player's edge (docked only)
let side = 'right';      // the player's edge that faces the app
let mainAnim = false;
let mainHome = null;
let liveSince = 0;        // when the live stream on screen started being watched (for Continue)
let liveLogins = new Set(); // channels live right now (from the Twitch source status)
let dragging = false;     // the docked player and the app are being dragged together
let dragTimer = null;     // where the app was before it was slid away

const mode = () => (MODES.includes(config.get().settings.playerMode) ? config.get().settings.playerMode : 'docked');
const alive = () => !!player && !player.isDestroyed();
const workArea = (r) => screen.getDisplayMatching(r).workArea;
const validRect = (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0;

// Pull a rect back onto the display it (mostly) sits on.
function onScreen(r) {
  const wa = workArea(r);
  const width = Math.min(r.width, wa.width), height = Math.min(r.height, wa.height);
  return { x: Math.round(Math.max(wa.x, Math.min(r.x, wa.x + wa.width - width))), y: Math.round(Math.max(wa.y, Math.min(r.y, wa.y + wa.height - height))), width: Math.round(width), height: Math.round(height) };
}

// Detached: 16:9 plus the header at `width` (default base's), top-left at base, leaving room for chat underneath.
function floatBounds(base, width) {
  const wa = workArea(base);
  const below = chatWanted() ? CHAT_MIN + GAP : 0;
  let w = Math.max(MIN_WIDTH, width || base.width);
  w = Math.round(Math.min(w, wa.width, ((wa.height - below - HEADER) * 16) / 9));
  return onScreen({ x: base.x, y: base.y, width: w, height: Math.round((w * 9) / 16) + HEADER });
}

// PiP: where it was left, else the bottom-right corner of the main window's screen. Pure 16:9, no header.
function pipBounds() {
  const saved = config.get().settings.playerPip;
  if (validRect(saved)) { const w = Math.max(PIP_MIN, saved.width); return onScreen({ x: saved.x, y: saved.y, width: w, height: Math.round((w * 9) / 16) }); }
  const wa = workArea(main().getBounds());
  const h = Math.round((PIP_WIDTH * 9) / 16);
  return { x: wa.x + wa.width - PIP_WIDTH - MARGIN, y: wa.y + wa.height - h - MARGIN, width: PIP_WIDTH, height: h };
}

function targetBounds() {
  const m = mode();
  if (m === 'pip') return pipBounds();
  if (m === 'detached') {
    const saved = config.get().settings.playerFloat;
    return floatBounds(validRect(saved) ? saved : alive() && player.isVisible() ? player.getBounds() : dockBounds());
  }
  return dockBounds();
}

const fmtTime = (sec) => `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m${Math.floor(sec % 60)}s`;

// The size picked in the player header (small/medium/large/max), or 'custom' after dragging the edge.
function sizeName() {
  const s = config.get().settings;
  return s.playerSize || (s.playerWidth ? 'custom' : 'medium');
}

function dockBounds() {
  const b = main().getBounds();
  const { workArea: wa } = screen.getDisplayMatching(b);
  const s = config.get().settings;
  const size = sizeName();
  const left = b.x - GAP - wa.x;
  const right = wa.x + wa.width - (b.x + b.width + GAP);
  const onLeft = left >= MIN_WIDTH || left >= right;
  side = onLeft ? 'right' : 'left';
  const room = Math.max(MIN_WIDTH, onLeft ? left : right);
  let w = size === 'max' ? room : SIZES[size] || Number(s.playerWidth) || DEFAULT_WIDTH;
  w = Math.max(MIN_WIDTH, Math.min(w, room));
  // Keep the whole thing on screen, leaving space for the chat panel underneath when it is showing
  // (at least 28% of the screen height, so a big player never squeezes chat into a strip).
  const below = chatWanted() ? Math.max(CHAT_MIN, Math.round(wa.height * 0.28)) + GAP : 0;
  const maxH = wa.height - below;
  if ((w * 9) / 16 + HEADER > maxH) w = ((maxH - HEADER) * 16) / 9;
  w = Math.round(w);
  const h = Math.round((w * 9) / 16) + HEADER;
  const x = onLeft ? b.x - GAP - w : b.x + b.width + GAP;
  const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - h - below));
  return { x: Math.round(x), y, width: w, height: h };
}

// Docked: under the player, same width, down to the main window's bottom (or further if that leaves too little
// room). Floating: under the player if there is room on screen, otherwise beside it.
function chatBounds(pb) {
  const wa = workArea(pb);
  const y = pb.y + pb.height + GAP;
  if (mode() === 'docked') {
    const mb = main().getBounds();
    const bottom = Math.min(wa.y + wa.height, Math.max(mb.y + mb.height, y + 320));
    return bottom - y >= CHAT_MIN ? { x: pb.x, y, width: pb.width, height: bottom - y } : null;
  }
  const room = wa.y + wa.height - y;
  if (room >= CHAT_MIN) return { x: pb.x, y, width: pb.width, height: Math.min(room, Math.max(320, Math.round(pb.height * 0.8))) };
  const w = 340;
  const x = pb.x + pb.width + GAP + w <= wa.x + wa.width ? pb.x + pb.width + GAP : pb.x - GAP - w;
  return x >= wa.x ? { x, y: pb.y, width: w, height: pb.height } : null;
}

// Put the player where its mode says (only docked moves it) and the chat under it.
function dock() {
  if (!alive() || player.isFullScreen() || animating) return;
  docking = true;
  let pb = player.getBounds();
  if (mode() === 'docked') {
    pb = dockBounds();
    player.setBounds(pb);
  }
  if (chat && !chat.isDestroyed() && chat.isVisible()) { const cb = chatBounds(pb); if (cb) chat.setBounds(cb); }
  setTimeout(() => { docking = false; }, 50);
}

// Docked, the player and the app move as one: dragging the player's header carries the app (and chat) along,
// just as dragging the app carries the player. A native drag region cannot do this (and does not work at all on
// a window owned by the app), so the page reports press and release and this follows the cursor in between.
function drag(what) {
  clearInterval(dragTimer);
  dragTimer = null;
  if (what !== 'start') {
    if (dragging) { dragging = false; if (!collapsed) dock(); }
    return;
  }
  if (!alive() || mode() !== 'docked' || player.isFullScreen() || animating || mainAnim) return;
  const c = screen.getCursorScreenPoint();
  const p = player.getBounds();
  const m = collapsed && mainHome ? mainHome : main().getBounds();
  const cb = chat && !chat.isDestroyed() && chat.isVisible() ? chat.getBounds() : null;
  const started = Date.now();
  let last = '0,0';
  dragging = true;
  // Every move passes the size it started with: on a scaled display each setPosition rounds the size up a
  // pixel, so a held mouse button would slowly grow the windows.
  const at = (r, dx, dy) => ({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height });
  dragTimer = setInterval(() => {
    if (!alive() || Date.now() - started > 120000) return drag('end'); // never follow the mouse forever
    const q = screen.getCursorScreenPoint();
    const dx = q.x - c.x, dy = q.y - c.y;
    if (`${dx},${dy}` === last) return; // held still: leave the windows alone
    last = `${dx},${dy}`;
    player.setBounds(at(p, dx, dy));
    main().setBounds(at(m, dx, dy)); // hidden (slid away) or not, so it comes back beside the player
    if (collapsed && mainHome) mainHome = at(m, dx, dy);
    if (cb && chat && !chat.isDestroyed()) chat.setBounds(at(cb, dx, dy));
  }, 16);
}

// Glide the player (and chat) to new bounds: a new size, or a switch between docked, detached and PiP.
let anim = null;
function animateTo(to) {
  if (!alive() || player.isFullScreen()) return;
  clearInterval(anim);
  const from = player.getBounds();
  const cFrom = chat && !chat.isDestroyed() && chat.isVisible() ? chat.getBounds() : null;
  const cTo = cFrom ? chatBounds(to) : null;
  const start = Date.now(), dur = 240;
  const lerp = (a, b, t) => Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Math.round(a[k] + (b[k] - a[k]) * t)]));
  docking = animating = true;
  anim = setInterval(() => {
    const k = Math.min(1, (Date.now() - start) / dur);
    const t = 1 - Math.pow(1 - k, 3); // ease out
    if (!alive()) { clearInterval(anim); docking = animating = false; return; }
    player.setBounds(lerp(from, to, t));
    if (cFrom && cTo && chat && !chat.isDestroyed()) chat.setBounds(lerp(cFrom, cTo, t));
    if (k >= 1) { clearInterval(anim); setTimeout(() => { docking = animating = false; saveFloat(); syncChat(); }, 60); }
  }, 16);
}

function setSize(size) {
  if (!['small', 'medium', 'large', 'max'].includes(size) || !alive()) return;
  const m = mode();
  if (m === 'pip') return;
  send('player:sizeState', size);
  if (m === 'detached') {
    const b = player.getBounds();
    return animateTo(floatBounds(b, size === 'max' ? workArea(b).width : SIZES[size]));
  }
  config.update((cfg) => { cfg.settings.playerSize = size; });
  animateTo(dockBounds());
}

// ---------- slide the app away from a docked player (the tab on the player's edge) ----------
function sendEdge() { send('player:edge', { side, collapsed }); }

// Tuck the main window 60 px in behind the player while fading it (out), or slide it back out. Moving towards the
// player keeps it on the same screen (sliding the other way can cross onto another monitor and rescale it).
function slideMain(out, done) {
  const w = main();
  const b = out || !mainHome ? w.getBounds() : mainHome; // a hidden window can report a stale position
  if (out) mainHome = b;
  const dx = (side === 'right' ? -1 : 1) * 60;
  const start = Date.now(), dur = 220;
  mainAnim = true;
  if (!out) { w.setOpacity(0); w.setBounds({ ...b, x: b.x + dx }); w.show(); }
  const iv = setInterval(() => {
    const k = Math.min(1, (Date.now() - start) / dur);
    const p = out ? k * k : Math.pow(1 - k, 3); // 0 = in place, 1 = slid away
    w.setBounds({ ...b, x: Math.round(b.x + dx * p) }); // always the original size, so rounding cannot build up
    w.setOpacity(1 - p);
    if (k >= 1) { clearInterval(iv); mainAnim = false; if (!out) w.setBounds(b); if (done) done(b); }
  }, 16);
}

function setCollapsed(on) {
  if (!alive() || mode() !== 'docked' || mainAnim) return collapsed;
  const w = main();
  if (on && !collapsed && w.isVisible() && !w.isMinimized()) {
    collapsed = true;
    sendEdge();
    slideMain(true, (b) => { w.hide(); w.setBounds(b); w.setOpacity(1); });
  } else if (!on && collapsed) {
    collapsed = false;
    sendEdge();
    slideMain(false);
  }
  return collapsed;
}

// Remember where a detached or PiP player was left.
function saveFloat() {
  if (!alive() || player.isFullScreen() || animating || !player.isVisible()) return;
  const m = mode();
  if (m === 'docked') return;
  const b = player.getBounds();
  config.update((cfg) => { cfg.settings[m === 'pip' ? 'playerPip' : 'playerFloat'] = b; });
}

// Window behaviour for the current mode: docked is owned by the main window (hides with it, no taskbar button);
// detached is a normal window with a taskbar button; PiP floats above everything.
function applyMode() {
  if (!alive()) return;
  const m = mode();
  player.setParentWindow(m === 'docked' ? main() : null);
  player.setSkipTaskbar(m !== 'detached');
  player.setAlwaysOnTop(m === 'pip', 'floating');
  player.setAspectRatio(m === 'pip' ? 16 / 9 : 0);
  player.setMinimumSize(m === 'pip' ? PIP_MIN : m === 'detached' ? MIN_WIDTH : 0, 0);
  player.setMinimizable(m === 'detached');
  watchHover(m === 'pip');
  send('player:mode', m);
}

// PiP shows its header only while the pointer is over the window. The video is a separate page that swallows
// mouse events, so the main process watches the cursor instead.
function watchHover(on) {
  clearInterval(hoverTimer);
  hoverTimer = null;
  if (!on) { if (hovering) { hovering = false; send('player:hover', false); } return; }
  hoverTimer = setInterval(() => {
    if (!alive()) return;
    const p = screen.getCursorScreenPoint();
    const b = player.getBounds();
    const inside = player.isVisible() && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== hovering) { hovering = inside; send('player:hover', inside); }
  }, 120);
}

// m = 'docked' | 'detached' | 'pip' | 'unpip' (back to whatever it was before PiP).
function setMode(m) {
  if (!alive() || player.isFullScreen()) return mode();
  const prev = mode();
  if (m === 'unpip') m = prev === 'pip' ? config.get().settings.playerBeforePip || 'docked' : prev;
  if (!MODES.includes(m) || m === prev) return prev;
  saveFloat(); // remember where the old floating mode was left
  config.update((cfg) => { cfg.settings.playerMode = m; if (m === 'pip') cfg.settings.playerBeforePip = prev; });
  applyMode();
  if (m === 'docked') {
    // Docking into a hidden app would hide the video too, so bring the app back.
    const w = main();
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    send('player:sizeState', sizeName());
  }
  if (m === 'pip') syncChat(); // hide chat before the player shrinks
  animateTo(targetBounds());
  return m;
}

// ---------- live chat panel ----------
const chatOn = () => config.get().settings.playerChat !== false;
const chatWanted = () => !!(current && current.kind === 'live' && chatOn() && mode() !== 'pip');

function createChat() {
  chat = new BrowserWindow({
    x: 0, y: 0, width: 400, height: 300,
    frame: false,
    parent: player, // rides along with the player, docked or not
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'livechat-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  chat.setMenuBarVisibility(false);
  chat.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chat.webContents.on('will-navigate', (e) => e.preventDefault());
  chat.webContents.on('console-message', ({ level, message }) => { if (level === 'warning' || level === 'error') log.error('livechat', message); });
  chat.on('closed', () => { chat = null; chatReady = null; });
  chatReady = new Promise((resolve) => chat.webContents.once('did-finish-load', resolve));
  chat.loadFile(path.join(config.ROOT, 'src', 'renderer', 'livechat.html'));
}

// Show the chat when a live stream is playing, chat is switched on and the player is on screen; hide otherwise.
async function syncChat() {
  const want = chatWanted() && !!player && !player.isDestroyed() && player.isVisible() && !player.isFullScreen();
  send('player:chatState', { available: !!(current && current.kind === 'live') && mode() !== 'pip', on: chatOn() });
  if (!want) {
    if (chat && !chat.isDestroyed() && chat.isVisible()) { chat.webContents.send('livechat:visible', false); chat.hide(); }
    return;
  }
  dock(); // turning chat on can shrink a big player so both fit
  const cb = chatBounds(player.getBounds());
  if (!cb) return;
  if (!chat || chat.isDestroyed()) createChat();
  await chatReady;
  if (!chat || chat.isDestroyed()) return;
  const u = (store.get().twitch.users || {})[current.login] || {};
  chat.webContents.send('livechat:channel', { login: current.login, id: u.id || null, display: current.display, title: current.title, game: current.game, recap: ai.enabled() });
  if (!chat.isVisible()) {
    chat.setBounds(cb);
    chat.setOpacity(0);
    chat.showInactive();
    fadeIn(chat);
    chat.webContents.send('livechat:visible', true);
  }
}

// Signed in or out: the chat panel reconnects as you (or anonymously).
function chatAuthChanged() {
  if (chat && !chat.isDestroyed()) chat.webContents.send('livechat:authChanged');
  sendPrefs();
  raids.watch(current && current.kind === 'live' ? current.login : null);
}

function setChat(on) {
  config.update((cfg) => { cfg.settings.playerChat = !!on; });
  syncChat();
}

function send(channel, ...args) {
  if (player && !player.isDestroyed()) player.webContents.send(channel, ...args);
}

async function sample() {
  if (!guest || guest.isDestroyed() || !playing || playing.kind !== 'vod') return;
  const cur = playing;
  let r;
  try {
    r = await guest.executeJavaScript(`(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, d: v.duration } : null; })()`);
  } catch { return; }
  // Pre-roll ads play in the same <video>; only a reading about as long as the VOD (or longer, if it is still
  // recording) is the VOD itself.
  if (!r || !r.d || !isFinite(r.d) || r.d < cur.dur - Math.max(60, cur.dur * 0.05) || r.t < 5) return;
  onProgress(cur.id, vods.record(cur.id, r.t, r.d));
  if (r.d - r.t < 30) continueOn(cur, r.t, r.d);
}

// Near the end of a VOD, keep going instead of stopping:
//  - still recording and longer now than when it was opened (the player only knows the length it loaded):
//    reload it where you are;
//  - caught up with a stream that is still live: switch to the live stream (then it plays until they go offline);
//  - the channel's next broadcast started soon after (a stream that dropped and restarted): play that from 0:00;
//  - it ended but the channel is live again: the live stream.
let continuing = null; // the VOD id being handled, so each end is handled once
async function continueOn(cur, t, d) {
  if (continuing === cur.id || !current || current.kind !== 'vod') return;
  continuing = cur.id;
  if (sleepAtEnd) { sleepAtEnd = false; send('player:sleepNow'); return; } // sleep timer: stop here
  const meta = current;
  let c;
  try { c = await vods.continuation(cur.id); } catch (e) { log.warn('player', `continue after ${cur.id}: ${e.message}`); }
  if (!alive() || !playing || playing.id !== cur.id) return; // moved on meanwhile
  if (!c) { continuing = null; return; }
  const who = meta.display || meta.login;
  if (c.dur - d > 30 && c.dur - t > 60) {
    log.info('player', `VOD ${cur.id} grew to ${Math.round(c.dur)}s (player had ${Math.round(d)}s): reloading at ${Math.round(t)}s`);
    playing.dur = c.dur;
    meta.dur = c.dur;
    send('player:reload', { key: cur.id, url: vodUrl(cur.id, t) });
    send('player:toast', 'More of this stream has been recorded: carrying on');
    setTimeout(() => { if (continuing === cur.id) continuing = null; }, 60e3); // may need to grow again later
    return;
  }
  if (c.recording) {
    log.info('player', `VOD ${cur.id}: caught up with the live stream`);
    send('player:toast', `Caught up: ${who} is live now`);
    return goLive(meta, c.live);
  }
  if (c.next) {
    log.info('player', `VOD ${cur.id} ended: next part ${c.next.id}`);
    send('player:toast', `Carrying on into ${who}'s next stream`);
    return play({
      kind: 'vod', id: c.next.id, dur: c.next.dur, login: meta.login, display: meta.display, avatar: meta.avatar, title: c.next.title,
      thumb: c.live && c.live.thumb, link: c.next.url, restart: true, sub: 'Next part of the stream',
    });
  }
  if (c.live) {
    send('player:toast', `${who} is live again`);
    return goLive(meta, c.live);
  }
  send('player:toast', 'End of the broadcast');
}

// ---------- the player page's preferences, media keys, next/previous ----------
// bgLow: streams out of sight play at the lowest quality. audio: audio mode (lowest quality, picture hidden).
// volumes: remembered volume per channel.
// Watch time per channel per day (state.json `stats.days[YYYY-MM-DD][login]`, seconds), counted every 15 s
// while something is actually playing in the player.
const STAT_EVERY = 15;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
setInterval(async () => {
  if (!alive() || !current || !guest || guest.isDestroyed() || hiddenWithMain) return;
  let on = false;
  try { on = await guest.executeJavaScript(`(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.readyState >= 3; })()`); } catch { return; }
  if (!on || !current) return;
  const s = store.get();
  s.stats = s.stats || { days: {} };
  const day = (s.stats.days[today()] = s.stats.days[today()] || {});
  day[current.login] = (day[current.login] || 0) + STAT_EVERY;
  const keys = Object.keys(s.stats.days).sort();
  while (keys.length > 120) delete s.stats.days[keys.shift()]; // four months is plenty
  store.save();
}, STAT_EVERY * 1000);

function prefs() {
  const s = config.get().settings;
  return { bgLow: s.backgroundLow !== false, audio: !!s.audioMode, volumes: store.get().volumes || {}, raids: raids.enabled() };
}
const sendPrefs = () => send('player:prefs', prefs());

function setAudio(on) {
  config.update((c) => { c.settings.audioMode = !!on; });
  sendPrefs();
  return !!on;
}

function saveVolume(login, volume) {
  if (!login || !Number.isFinite(volume)) return;
  const s = store.get();
  s.volumes = s.volumes || {};
  if (s.volumes[login] === volume) return;
  s.volumes[login] = Math.round(volume * 100) / 100;
  store.save();
}

let sleepAtEnd = false;  // sleep timer set to "end of this video": stop instead of carrying on
function setSleepAtEnd(on) { sleepAtEnd = !!on; return sleepAtEnd; }

// The next (or previous) live channel in the board's order, from whatever is playing.
function step(dir) {
  if (!liveList.length) return;
  const at = current ? liveList.findIndex((c) => c.login === current.login) : -1;
  const c = liveList[(at + dir + liveList.length) % liveList.length];
  if (c && (!current || current.kind !== 'live' || c.login !== current.login)) play(liveMeta(c));
}

function liveMeta(c) {
  return {
    kind: 'live', login: c.login, startedAt: Date.parse(c.startedAt) || null, display: c.display, avatar: c.avatar, title: c.title, game: c.game,
    thumb: c.thumb, link: c.url, sub: [c.game, c.viewers != null ? `${c.viewers.toLocaleString()} watching` : ''].filter(Boolean).join(' \u00b7 '),
  };
}

// Media keys (play/pause, next, previous) work anywhere while the player is open, then go back to other apps.
let keysOn = false;
function mediaKeys(on) {
  on = on && config.get().settings.mediaKeys !== false;
  if (on === keysOn) return;
  keysOn = on;
  if (!on) { for (const k of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop']) globalShortcut.unregister(k); return; }
  try {
    globalShortcut.register('MediaPlayPause', () => send('player:key', 'playpause'));
    globalShortcut.register('MediaStop', () => send('player:key', 'pause'));
    globalShortcut.register('MediaNextTrack', () => step(1));
    globalShortcut.register('MediaPreviousTrack', () => step(-1));
  } catch (e) { log.warn('player', `media keys: ${e.message}`); }
}

function goLive(meta, live) {
  return play({
    kind: 'live', login: meta.login, display: meta.display || live.display, avatar: meta.avatar, title: live.title, game: live.game,
    thumb: live.thumb, link: `https://www.twitch.tv/${meta.login}`, startedAt: live.startedAt,
    sub: [live.game, live.viewers != null ? `${live.viewers.toLocaleString()} watching` : ''].filter(Boolean).join(' \u00b7 '),
  });
}

// Player shortcuts from inside a stream's page, skipped while a text field has focus.
const GUEST_KEYS = `(() => { if (window.__tdKeys) return; window.__tdKeys = true;
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const t = e.composedPath()[0] || e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if (!'1234pdnbg'.includes(k) || k.length !== 1) return;
    e.preventDefault(); e.stopPropagation();
    console.log('[tdkey] ' + k);
  }, true);
})()`;
function guestKey(k) {
  const sz = { 1: 'small', 2: 'medium', 3: 'large', 4: 'max' }[k];
  if (sz) setSize(sz);
  else if (k === 'p') setMode(mode() === 'pip' ? 'unpip' : 'pip');
  else if (k === 'd') setMode(mode() === 'docked' ? 'detached' : 'docked');
  else if (k === 'n') step(1);
  else if (k === 'b') step(-1);
  else if (k === 'g') send('player:key', k);
}

function create() {
  const win = main();
  player = new BrowserWindow({
    ...targetBounds(),
    frame: false,
    parent: mode() === 'docked' ? win : undefined,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    backgroundColor: '#0f1115',
    icon: path.join(config.ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'player-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  player.setMenuBarVisibility(false);
  player.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // The webview may only ever show the Twitch player, locked down like any web page.
  player.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.autoplayPolicy = 'no-user-gesture-required';
    prefs.backgroundThrottling = false; // kept streams play on while the player window is hidden
    if (!/^https:\/\/player\.twitch\.tv\//.test(params.src || 'https://player.twitch.tv/')) e.preventDefault();
  });
  player.webContents.on('did-attach-webview', (_e, wc) => {
    guest = wc;
    wc.setAudioMuted(true); // every stream starts silent; the page unmutes the one on screen
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    // Links inside the player (channel name, "watch on Twitch") open in the browser instead of replacing the video.
    wc.on('will-navigate', (e, url) => { if (!/^https:\/\/player\.twitch\.tv\//.test(url)) { e.preventDefault(); shell.openExternal(url); } });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F11') { toggleFullScreen(); e.preventDefault(); }
      if (input.key === 'Escape' && player && player.isFullScreen()) { toggleFullScreen(false); e.preventDefault(); }
    });
    // The letter and number keys are caught inside the Twitch page, where it can tell whether you are typing
    // (signing in to a mature/gambling stream, say); it reports them as console '[tdkey] <key>'.
    wc.on('dom-ready', () => wc.executeJavaScript(GUEST_KEYS).catch(() => {}));
    wc.on('console-message', ({ message }) => { if (message.startsWith('[tdkey] ')) guestKey(message.slice(8)); });
  });
  player.webContents.on('console-message', ({ level, message }) => { if (level === 'warning' || level === 'error') log.error('player', message); });

  // Width is the user's to change (drag an edge); height always follows 16:9 (PiP: the OS keeps the ratio).
  player.on('resized', () => {
    if (docking || animating || dragging || player.isFullScreen()) return;
    const m = mode();
    const b = player.getBounds();
    if (m === 'docked') {
      config.update((cfg) => { cfg.settings.playerWidth = b.width; cfg.settings.playerSize = 'custom'; });
      send('player:sizeState', 'custom');
    } else if (m === 'detached') {
      const h = Math.round((b.width * 9) / 16) + HEADER;
      if (Math.abs(b.height - h) > 1) { docking = true; player.setBounds({ ...b, height: h }); setTimeout(() => { docking = false; }, 50); }
      send('player:sizeState', 'custom');
    }
    saveFloat();
    dock();
  });
  // A floating player drags its chat along and remembers where it was left.
  player.on('move', () => {
    if (mode() === 'docked' || animating || player.isFullScreen()) return;
    if (chat && !chat.isDestroyed() && chat.isVisible()) { const cb = chatBounds(player.getBounds()); if (cb) chat.setBounds(cb); }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFloat, 400);
  });
  player.on('enter-full-screen', () => syncChat());
  player.on('leave-full-screen', () => setTimeout(() => { dock(); syncChat(); }, 50));
  player.on('close', () => {
    noteLeave();
    clearInterval(timer); timer = null;
    if (chat && !chat.isDestroyed()) chat.close();
    if (collapsed) { collapsed = false; main().show(); } // never leave the user with no window
  });
  player.on('closed', () => { mediaKeys(false); sleepAtEnd = false; raids.watch(null); raids.setSession(null); clearInterval(hoverTimer); hoverTimer = null; hovering = false; clearTimeout(saveTimer); player = null; guest = null; playing = null; current = null; ready = null; onNowPlaying(null); });

  ready = new Promise((resolve) => player.webContents.once('did-finish-load', resolve));
  player.loadFile(path.join(config.ROOT, 'src', 'renderer', 'player.html'));
  applyMode();
}

// Follow the main window around.
function attach(getMain) {
  main = getMain;
  const win = main();
  const follow = () => { if (player && player.isVisible() && mode() === 'docked' && !mainAnim && !collapsed && !dragging) dock(); };
  win.on('move', follow);
  win.on('resize', follow);
  const hide = () => {
    if (collapsed) return; // slid away on purpose: the player stays
    if (alive() && !current) { player.close(); return; } // only holding kept channels: let them go
    if (!player || !player.isVisible() || mode() !== 'docked') return; // a floating player stays up
    hiddenWithMain = true;
    send('player:pause');
    player.hide();
    syncChat();
  };
  const show = () => {
    if (collapsed) { collapsed = false; sendEdge(); } // brought back some other way (tray, dock)
    if (!alive()) { syncKeep(); return; }
    if (!player || !hiddenWithMain) return;
    hiddenWithMain = false;
    dock();
    player.showInactive();
    send('player:resume');
    syncChat();
  };
  win.on('hide', hide);
  win.on('minimize', hide);
  win.on('show', show);
  win.on('restore', show);
}

function toggleFullScreen(on) {
  if (!player) return;
  player.setFullScreen(on === undefined ? !player.isFullScreen() : !!on);
}

const vodUrl = (id, from) => `https://player.twitch.tv/?video=v${id}&parent=twitch.tv&autoplay=true&muted=false${from ? `&time=${fmtTime(from)}` : ''}`;
const liveUrl = (login) => `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=twitch.tv&autoplay=true&muted=false`;

// ---------- keep active ----------
// settings.twitchKeepActive lists channels whose live stream stays loaded (muted, out of sight) in the player the
// whole time they are live, so switching to them is instant, the first time too: while the app window is up
// the player is created hidden just to hold them, and closed again when the app is hidden with nothing playing.
const keepList = () => (config.get().settings.twitchKeepActive || []).filter((l) => liveLogins.has(l));
const appShowing = () => { const w = main && main(); return !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized(); };

// channels = the poller's roster.
let liveList = [];       // live channels as the board orders them (favourites first, then viewers)
function setLive(channels) {
  const fav = new Set(config.get().favourites || []);
  liveList = (channels || []).filter((c) => c.live)
    .sort((a, b) => (fav.has(b.login) ? 1 : 0) - (fav.has(a.login) ? 1 : 0) || (b.viewers || 0) - (a.viewers || 0));
  const next = new Set(liveList.map((c) => c.login));
  const changed = next.size !== liveLogins.size || [...next].some((l) => !liveLogins.has(l));
  liveLogins = next;
  if (changed) syncKeep();
}

async function syncKeep() {
  if (!alive()) {
    if (!keepList().length || !appShowing() || config.get().settings.paused) return;
    create(); // hidden until something is played
    await ready;
    sendPrefs();
  }
  if (!ready) return;
  await ready;
  send('player:keep', keepList().map((login) => {
    const c = liveList.find((x) => x.login === login) || { login, display: login };
    return { key: `live:${login}`, url: liveUrl(login), meta: liveMeta(c) };
  }));
}

function toggleKeep(login) {
  let on = false;
  config.update((cfg) => {
    const set = new Set(cfg.settings.twitchKeepActive || []);
    on = !set.has(login);
    if (on) set.add(login); else set.delete(login);
    cfg.settings.twitchKeepActive = [...set];
  });
  syncKeep();
  return { on, list: config.get().settings.twitchKeepActive, playerOpen: alive() || appShowing() };
}

// meta = { kind: 'vod' | 'live', id (vod), dur (vod), login, display, avatar, title, thumb, sub, link, restart }
async function play(meta) {
  let url;
  if (meta.kind === 'vod') {
    const from = meta.at != null ? Math.max(0, meta.at) : vods.resumeAt(meta.id, meta.restart);
    url = vodUrl(meta.id, from);
  } else if (meta.kind === 'live') {
    url = liveUrl(meta.login);
  } else return false;

  if (!player || player.isDestroyed()) create();
  else { await sample(); guest = null; noteLeave(); } // last reading of the old one; the page reports the new one (setActive)
  await ready;
  playing = { kind: meta.kind, key: meta.kind === 'vod' ? meta.id : `live:${meta.login}`, id: meta.id, dur: meta.dur };
  current = meta;
  if (meta.kind === 'vod') { const p = vods.touch(meta.id, meta.dur, meta); if (p) onProgress(meta.id, p); }
  liveSince = meta.kind === 'live' ? Date.now() : 0;
  continuing = null;
  onNowPlaying(playing.key);

  if (!player.isVisible()) {
    const win = main();
    if (mode() !== 'docked') { player.setBounds(targetBounds()); player.setOpacity(0); player.showInactive(); fadeIn(player); }
    else {
      dock();
      if (win.isVisible() && !win.isMinimized()) { player.setOpacity(0); player.showInactive(); fadeIn(player); }
      else hiddenWithMain = true;
    }
  }
  send('player:mode', mode());
  sendEdge();
  sendPrefs();
  mediaKeys(true);
  raids.watch(meta.kind === 'live' ? meta.login : null);
  send('player:load', { url, meta, key: playing.key });
  if (meta.kind === 'vod') {
    vods.chapters(meta.id).then((list) => send('player:chapters', { key: meta.id, chapters: list }), (e) => log.warn('player', `chapters of ${meta.id}: ${e.message}`));
  }
  syncKeep(); // load the kept channels in the background
  if (meta.kind === 'vod' && config.get().settings.skipMuted !== false) {
    vods.mutedSegments(meta.id).then((segments) => {
      if (segments.length) log.info('player', `VOD ${meta.id}: ${segments.length} muted part(s) to skip`);
      send('player:muted', { key: meta.id, segments, dur: meta.dur });
    }, (e) => log.warn('player', `muted parts of ${meta.id}: ${e.message}`));
  }
  send('player:sizeState', mode() === 'docked' ? sizeName() : 'custom');
  syncChat();
  clearInterval(timer);
  timer = meta.kind === 'vod' ? setInterval(sample, 5000) : null;
  return true;
}

function fadeIn(w) {
  let o = 0;
  const step = setInterval(() => {
    o = Math.min(1, o + 0.12);
    if (!w || w.isDestroyed()) return clearInterval(step);
    w.setOpacity(o);
    if (o >= 1) clearInterval(step);
  }, 16);
}

// The header's minimise: docked, the whole app goes to the taskbar (the player hides and pauses with it, as when
// the app is minimised); detached, just the player (it has its own taskbar button). PiP has no such button.
function minimize() {
  if (!alive() || player.isFullScreen()) return;
  if (mode() === 'detached') player.minimize();
  else if (mode() === 'docked') main().minimize();
}

async function close() {
  await sample();
  if (player && !player.isDestroyed()) player.close();
}

// Dev screenshots (--shot): the panel as it looks on screen, video included.
async function capture(which = 'player') {
  const w = which === 'chat' ? chat : player;
  if (!w || w.isDestroyed() || !w.isVisible()) return null;
  return w.webContents.capturePage();
}

function contents(which) {
  const w = which === 'chat' ? chat : player;
  return w && !w.isDestroyed() ? w.webContents : null;
}

function bounds() {
  return player && !player.isDestroyed() ? player.getBounds() : null;
}

// Leaving a live stream after watching it for a minute or more puts it in Continue.
function noteLeave() {
  if (current && current.kind === 'live' && liveSince && Date.now() - liveSince >= 60e3) vods.noteLive(current, Date.now());
  liveSince = 0;
}

// Continue a live stream you left: its broadcast's VOD from a little before you left (catching up, or after it ended).
async function catchUp(w) {
  let v;
  try { v = await vods.broadcastFor(w.login, w.startedAt); } catch (e) { return { ok: false, error: e.message }; }
  if (!v) return { ok: false, error: `${w.display || w.login} has no recording of that stream (VODs off or hidden)` };
  const at = w.startedAt ? Math.max(0, (w.leftAt - w.startedAt) / 1000 - 15) : 0;
  await play({
    kind: 'vod', id: v.id, dur: v.dur, login: w.login, display: w.display, avatar: w.avatar, title: v.title || w.title,
    thumb: w.thumb, link: v.url, at, sub: 'Catching up from where you left',
  });
  vods.forget({ kind: 'live', login: w.login }); // the VOD's own progress takes over
  return { ok: true };
}

// Watch a live stream from its beginning: the VOD Twitch is recording of it, from 0:00. meta = the live meta
// (from the board), or whatever live stream is playing (the player header button).
async function fromStart(meta) {
  meta = meta || current;
  if (!meta || !meta.login) return { ok: false, error: 'Nothing live is playing' };
  let v;
  try { v = await vods.currentBroadcast(meta.login, meta.startedAt); } catch (e) { return { ok: false, error: e.message }; }
  if (!v) return { ok: false, error: `${meta.display || meta.login} has no recording of this stream (VODs off or hidden)` };
  await play({
    kind: 'vod', id: v.id, dur: v.dur, login: meta.login, display: meta.display, avatar: meta.avatar, title: v.title || meta.title,
    thumb: meta.thumb, link: v.url, restart: true, sub: 'Live stream, from the start',
  });
  return { ok: true };
}

// The player page says which of its webviews is on screen (it keeps recent ones warm), so VOD sampling reads that one.
function setActive(id) {
  const wc = webContents.fromId(Number(id));
  if (wc && !wc.isDestroyed() && alive() && wc.hostWebContents === player.webContents) guest = wc;
}

function nowPlaying() {
  return playing ? playing.key : null;
}

function init(opts) {
  onProgress = opts.onProgress || onProgress;
  onNowPlaying = opts.onNowPlaying || onNowPlaying;
}

module.exports = { init, attach, play, close, minimize, syncChat, toggleFullScreen, nowPlaying, capture, bounds, contents, setChat, chatOn, setSize, setMode, mode, setActive, setCollapsed, drag, setLive, toggleKeep, fromStart, catchUp, chatAuthChanged, setAudio, saveVolume, setSleepAtEnd, step, liveMeta, sendPrefs };
