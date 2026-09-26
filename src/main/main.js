'use strict';
// Twitch Desktop: the window (the board: Live / Continue / VODs / Channels / Settings), the tray, go-live toasts
// for favourites, and the IPC for everything the window and the player panels ask for.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, screen } = require('electron');
const config = require('./config');
const store = require('./store');
const twitch = require('./twitch');
const poller = require('./poller');
const vods = require('./vods');
const player = require('./player');
const ai = require('./ai');
const auth = require('./auth');
const raids = require('./raids');
const emotes = require('./emotes');
const schedule = require('./schedule');
const updater = require('./updater');
const log = require('./log');

config.ensureDir();
log.setFile(path.join(config.DATA_DIR, 'app.log'));

// A stray error (offline, an odd Twitch response) goes in the log rather than taking the app down.
process.on('unhandledRejection', (reason) => log.error('process', `unhandled rejection: ${(reason && reason.stack) || reason}`));
process.on('uncaughtException', (err) => log.error('process', `uncaught exception: ${(err && err.stack) || err}`));

const ICON = path.join(config.ROOT, 'assets', 'icon.png');
const TRAY_ICON = path.join(config.ROOT, 'assets', 'tray.png');
const DEV = process.argv.includes('--dev');
const NAME = 'Twitch Desktop';

let win = null;
let tray = null;
let quitting = false;

// Windows toast notifications need an AppUserModelId (electron-builder's appId); unpackaged apps use the exe path.
app.setAppUserModelId(app.isPackaged ? 'io.github.brownaye.twitchdesktop' : process.execPath);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Where the window was last left, if that is still on a screen; otherwise the bottom-right corner.
function startBounds() {
  const saved = config.get().settings.windowBounds;
  const { workArea } = screen.getPrimaryDisplay();
  const width = 460;
  const height = Math.min(860, workArea.height - 24);
  const fallback = { width, height, x: workArea.x + workArea.width - width - 12, y: workArea.y + workArea.height - height - 12 };
  if (!saved || !Number.isFinite(saved.x)) return fallback;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x + 60 > a.x && saved.x < a.x + a.width - 60 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 60;
  });
  return onScreen ? saved : fallback;
}

function createWindow() {
  win = new BrowserWindow({
    ...startBounds(),
    minWidth: 380,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0e0e10',
    alwaysOnTop: !!config.get().settings.alwaysOnTop,
    show: !config.get().settings.startMinimized,
    icon: ICON,
    title: NAME,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'warning' || level === 'error') log.error('renderer', `${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
  });
  win.loadFile(path.join(config.ROOT, 'src', 'renderer', 'index.html'));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  devHooks();

  let boundsTimer = null;
  const remember = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      config.update((c) => { c.settings.windowBounds = win.getBounds(); });
    }, 800);
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('close', (e) => {
    if (!quitting && config.get().settings.closeToTray !== false) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Dev helpers (for checking changes without a mouse): --view=<live|continue|vods|channels|settings> picks a tab,
// --screenshot=<file> saves the window after --shot-delay (4 s), --click=[chat:|player:]<selector>@<ms> clicks,
// --eval=[chat:|player:]<js>@<ms> runs a snippet, --shot=<file>@<ms> saves the window and any player/chat panel.
function devHooks() {
  const arg = (name) => (process.argv.find((a) => a.startsWith(name)) || '').slice(name.length);
  const timed = (flag) => process.argv.filter((a) => a.startsWith(flag)).map((a) => { const [v, ms] = a.slice(flag.length).split('@'); return { v, ms: Number(ms) || 8000 }; });
  const viewArg = arg('--view=');
  const shotArg = arg('--screenshot=');
  if (!(viewArg || shotArg || timed('--click=').length || timed('--shot=').length || timed('--eval=').length)) return;
  win.webContents.once('did-finish-load', () => {
    if (viewArg) setTimeout(() => send('ui:view', viewArg), 300);
    if (shotArg) setTimeout(async () => {
      fs.writeFileSync(shotArg, (await win.webContents.capturePage()).toPNG());
      log.info('dev', `screenshot saved to ${shotArg}`);
    }, Number(arg('--shot-delay=')) || 4000);
    if (timed('--click=').length) showWindow(); // clicks may open the player, which only shows beside a visible window
    for (const { v, ms } of timed('--eval=')) setTimeout(() => {
      const [, where, js] = /^(?:(chat|player):)?(.*)$/.exec(v);
      const wc = where ? player.contents(where) : win.webContents;
      if (wc) wc.executeJavaScript(js).then(() => log.info('dev', `eval ${v.slice(0, 60)}: done`), (e) => log.info('dev', `eval ${v.slice(0, 60)}: ${e.message}`));
    }, ms);
    for (const { v, ms } of timed('--click=')) setTimeout(() => {
      const [, where, sel] = /^(?:(chat|player):)?(.*)$/.exec(v);
      const wc = where ? player.contents(where) : win.webContents;
      if (!wc) { log.info('dev', `click ${v}: no ${where} window`); return; }
      wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el; })()`).then((ok) => log.info('dev', `click ${v}: ${ok ? 'done' : 'not found'}`));
    }, ms);
    for (const { v, ms } of timed('--shot=')) setTimeout(async () => {
      fs.writeFileSync(v, (await win.webContents.capturePage()).toPNG());
      const img = await player.capture();
      if (img) fs.writeFileSync(v.replace(/\.png$/i, '') + '-player.png', img.toPNG());
      const chatImg = await player.capture('chat');
      if (chatImg) fs.writeFileSync(v.replace(/\.png$/i, '') + '-chat.png', chatImg.toPNG());
      log.info('dev', `shot saved to ${v}${img ? ' (+ player)' : ''} main=${JSON.stringify(win.getBounds())} player=${JSON.stringify(player.bounds())}`);
    }, ms);
  });
}

function createTray() {
  const img = nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  const rebuild = () => {
    const off = !!config.get().settings.paused;
    const live = poller.status.channels.filter((c) => c.live).length;
    tray.setToolTip(`${NAME}${live ? ` - ${live} live` : ''}${off ? ' (off)' : ''}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${NAME}`, click: showWindow },
      { label: 'Check channels now', enabled: !off, click: () => poller.poll() },
      { type: 'separator' },
      { label: off ? 'Resume checking' : 'Pause all checking', click: () => setPaused(!off) },
      { label: 'Always on top', type: 'checkbox', checked: !!config.get().settings.alwaysOnTop, click: (item) => setAlwaysOnTop(item.checked) },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  rebuild();
  tray.on('click', () => (win && win.isVisible() && !win.isMinimized() ? win.hide() : showWindow()));
  tray.rebuild = rebuild;
}

// "Turn off": no checking and every API-backed action refuses, until turned on again. Persisted, so a machine
// left off stays off across restarts.
function setPaused(v) {
  const was = !!config.get().settings.paused;
  config.update((c) => { c.settings.paused = !!v; });
  if (tray) tray.rebuild();
  send('settings:changed', config.get().settings);
  log.info('app', v ? 'turned OFF: checking and API calls stopped' : 'turned ON: checking resumed');
  if (was && !v) poller.poll();
  return !!v;
}

const PAUSED = { ok: false, error: 'Checking is paused. Press the power button to resume.' };
const paused = () => !!config.get().settings.paused;
const SIGN_IN = { ok: false, error: auth.SIGN_IN_FIRST, needsSignIn: true };
const signedIn = () => !!auth.user();

function setAlwaysOnTop(v) {
  config.update((c) => { c.settings.alwaysOnTop = !!v; });
  if (win) win.setAlwaysOnTop(!!v, 'floating');
  if (tray) tray.rebuild();
  send('settings:changed', config.get().settings);
}

// An alert: a Windows toast (clicking it runs onClick) and, if a topic is set, the phone through ntfy.
function alert(title, body, { onClick = null, url = null, tags = 'tv' } = {}) {
  const s = config.get().settings;
  if (s.toasts !== false && Notification.isSupported()) {
    const t = new Notification({ title, body: String(body || '').slice(0, 200), icon: ICON });
    t.on('click', () => { showWindow(); if (onClick) onClick(); });
    t.show();
  }
  const topic = String(s.ntfyTopic || '').trim();
  if (topic && !paused()) {
    const server = String(s.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
    fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST', body: String(body || ''),
      headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: tags, ...(url ? { Click: url } : {}) },
    }).catch((e) => log.warn('ntfy', e.message));
  }
}

// A favourite went live: clicking the toast opens the stream.
function liveToast(c) {
  if (!c || !config.get().favourites.includes(c.login)) return;
  alert(`${c.display} is live`, `${c.title || '(no title)'}${c.game ? ' - ' + c.game : ''}`, { onClick: () => player.play(player.liveMeta(c)).catch(() => {}), url: c.url, tags: 'red_circle' });
}

// Someone you follow is now playing a game on your alert list.
function gameToast(c) {
  alert(`${c.display} is playing ${c.game}`, c.title || '', { onClick: () => player.play(player.liveMeta(c)).catch(() => {}), url: c.url, tags: 'video_game' });
}

// Scheduled streams starting soon.
function remindDue() {
  for (const it of schedule.due()) {
    const at = new Date(it.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    alert(`${it.display} at ${at}`, `${it.title || 'Scheduled stream'}${it.game ? ' - ' + it.game : ''}`, { url: `https://www.twitch.tv/${it.login}`, tags: 'calendar' });
  }
}

function bootstrap() {
  const cfg = config.get();
  return {
    settings: cfg.settings,
    favourites: cfg.favourites,
    following: cfg.channels,
    status: poller.status,
    auth: auth.status(),
    setup: config.setup(),
    log: log.recent().slice(-80),
    dataDir: config.DATA_DIR,
  };
}

// ---------- channels ----------
async function addChannels(text) {
  const logins = twitch.parseLogins(text).filter((l) => !config.get().channels.includes(l));
  if (!logins.length) return { ok: false, error: 'No new channel names found.' };
  if (paused()) return PAUSED;
  if (!signedIn()) return SIGN_IN;
  let found;
  try { found = await twitch.lookupUsers(logins); } catch (e) { return { ok: false, error: e.message }; }
  const ok = found.map((u) => u.login);
  const unknown = logins.filter((l) => !ok.includes(l));
  if (!ok.length) return { ok: false, error: `Not found on Twitch: ${unknown.join(', ')}` };
  config.update((c) => { c.channels.push(...ok); });
  log.info('channels', `added ${ok.join(', ')}`);
  send('channels:changed', { following: config.get().channels, favourites: config.get().favourites });
  poller.poll();
  return { ok: true, added: found, unknown };
}

function removeChannel(login) {
  config.update((c) => {
    c.channels = c.channels.filter((l) => l !== login);
    c.favourites = c.favourites.filter((l) => l !== login);
    c.settings.twitchKeepActive = (c.settings.twitchKeepActive || []).filter((l) => l !== login);
  });
  poller.status.channels = poller.status.channels.filter((c) => c.login !== login);
  send('status', poller.status);
  send('channels:changed', { following: config.get().channels, favourites: config.get().favourites });
  return { ok: true };
}

// Channels you follow on Twitch that are not in the app yet get added (never removed: the app can follow more).
async function syncFollows({ quiet = false } = {}) {
  if (paused()) return PAUSED;
  if (!signedIn()) return SIGN_IN;
  let follows;
  try { follows = await auth.followed(); } catch (e) { if (!quiet) log.warn('follows', e.message); return { ok: false, error: e.message }; }
  const have = new Set(config.get().channels);
  const added = follows.filter((l) => !have.has(l));
  if (added.length) {
    config.update((c) => { c.channels.push(...added); });
    log.info('follows', `added ${added.length} channel(s) you follow on Twitch: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ', ...' : ''}`);
    send('channels:changed', { following: config.get().channels, favourites: config.get().favourites });
    poller.poll();
  }
  const extra = config.get().channels.filter((l) => !follows.includes(l));
  return { ok: true, added, total: follows.length, notFollowed: extra };
}

function setFavourite(login, on) {
  config.update((c) => {
    const set = new Set(c.favourites);
    if (on) set.add(login); else set.delete(login);
    c.favourites = c.channels.filter((l) => set.has(l));
  });
  send('channels:changed', { following: config.get().channels, favourites: config.get().favourites });
  return { ok: true, favourites: config.get().favourites };
}

// ---------- IPC ----------
ipcMain.handle('app:bootstrap', () => bootstrap());
ipcMain.handle('settings:update', (_e, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return config.get().settings;
  const before = config.get().settings.pollSeconds;
  if (typeof patch.openrouterKey === 'string') patch.openrouterKey = patch.openrouterKey.trim();
  if (typeof patch.openrouterModel === 'string') patch.openrouterModel = patch.openrouterModel.trim();
  config.update((c) => { c.settings = { ...c.settings, ...patch }; });
  if ('alwaysOnTop' in patch) setAlwaysOnTop(patch.alwaysOnTop);
  if ('paused' in patch) setPaused(patch.paused);
  if (config.get().settings.pollSeconds !== before) poller.start();
  if ('chatRecap' in patch || 'openrouterKey' in patch) player.syncChat(); // shows or hides the recap button
  send('settings:changed', config.get().settings);
  return config.get().settings;
});
ipcMain.handle('app:pause', (_e, v) => setPaused(v));
ipcMain.handle('poll:now', async () => { if (!paused() && signedIn()) await poller.poll(); return poller.status; });

ipcMain.handle('channels:add', (_e, text) => addChannels(text));
ipcMain.handle('channels:remove', (_e, login) => removeChannel(String(login || '')));
ipcMain.handle('schedule:get', async (_e, { force } = {}) => (paused() ? { ...(await schedule.get()), paused: true } : schedule.get({ force })));
ipcMain.handle('schedule:remind', (_e, { id, on }) => schedule.setRemind(String(id), !!on));
ipcMain.handle('stats:get', () => (store.get().stats || { days: {} }));
ipcMain.handle('ntfy:test', () => { alert('Twitch Desktop', 'Phone alerts are working', { tags: 'white_check_mark' }); return true; });
ipcMain.handle('follows:sync', () => syncFollows());
ipcMain.handle('auth:status', () => auth.status());
ipcMain.handle('auth:signIn', async () => { if (paused()) return { ...auth.status(), error: PAUSED.error }; try { return await auth.signIn(); } catch (e) { return { ...auth.status(), error: e.message }; } });
ipcMain.handle('auth:cancel', () => auth.cancel());
ipcMain.handle('auth:signOut', () => auth.signOut());
ipcMain.handle('livechat:auth', () => auth.chatLogin());
ipcMain.handle('channels:favourite', (_e, { login, on }) => setFavourite(String(login || ''), !!on));

ipcMain.handle('twitch:vods', async (_e, { refresh } = {}) => {
  if (paused()) return PAUSED;
  if (!signedIn()) return SIGN_IN;
  try { return { ok: true, ...(await vods.list({ refresh })) }; } catch (e) { return { ok: false, error: e.message, ...(e.code === 'SIGNED_OUT' ? { needsSignIn: true } : {}) }; }
});
ipcMain.handle('twitch:play', (_e, opts) => {
  if (paused()) return PAUSED;
  return player.play(opts || {}).then((ok) => ({ ok }), (e) => ({ ok: false, error: e.message }));
});
ipcMain.handle('twitch:watched', (_e, { id, done }) => ({ ok: true, progress: vods.setWatched(id, done) }));
ipcMain.handle('twitch:nowPlaying', () => player.nowPlaying());
ipcMain.handle('twitch:fromStart', (_e, meta) => (paused() ? PAUSED : !signedIn() ? SIGN_IN : player.fromStart(meta)));
ipcMain.handle('twitch:continue', () => ({ ok: true, list: vods.continueList() }));
ipcMain.handle('twitch:catchUp', (_e, w) => (paused() ? PAUSED : !signedIn() ? SIGN_IN : player.catchUp(w || {})));
ipcMain.handle('twitch:forget', (_e, what) => { vods.forget(what || {}); return { ok: true }; });
ipcMain.handle('twitch:keep', (_e, { login }) => ({ ok: true, ...player.toggleKeep(String(login || '')) }));

ipcMain.handle('player:play', (_e, meta) => (paused() ? PAUSED : player.play(meta || {}).then((ok) => ({ ok }), (e) => ({ ok: false, error: e.message }))));
ipcMain.handle('raids:session', (_e, id) => { raids.setSession(id); return true; });
ipcMain.handle('raids:target', async (_e, login) => { try { return await raids.target(String(login || '')); } catch (e) { return null; } });
ipcMain.handle('livechat:emotes', async (_e, id) => { try { return await emotes.forChannel(id); } catch { return {}; } });
ipcMain.handle('player:audio', (_e, on) => player.setAudio(on));
ipcMain.handle('player:volume', (_e, { login, volume }) => { player.saveVolume(String(login || ''), Number(volume)); return true; });
ipcMain.handle('player:sleepEnd', (_e, on) => player.setSleepAtEnd(on));
ipcMain.handle('player:step', (_e, dir) => { player.step(dir < 0 ? -1 : 1); return true; });
ipcMain.handle('player:fromStart', () => (paused() ? PAUSED : !signedIn() ? SIGN_IN : player.fromStart()));
ipcMain.handle('player:close', () => player.close());
ipcMain.handle('player:minimize', () => player.minimize());
ipcMain.handle('player:size', (_e, size) => { player.setSize(size); return true; });
ipcMain.handle('player:mode', (_e, m) => player.setMode(m));
ipcMain.handle('player:drag', (_e, what) => { player.drag(what); return true; });
ipcMain.handle('player:collapse', (_e, on) => player.setCollapsed(!!on));
ipcMain.handle('player:active', (_e, id) => { player.setActive(id); return true; });
ipcMain.handle('player:chat', (_e, on) => { player.setChat(on === undefined ? !player.chatOn() : on); return player.chatOn(); });
ipcMain.handle('player:fullscreen', (_e, on) => player.toggleFullScreen(on));
ipcMain.handle('player:external', (_e, url) => { if (/^https:\/\/(www\.)?twitch\.tv\//i.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('livechat:close', () => { player.setChat(false); return true; });
ipcMain.handle('livechat:external', (_e, url) => { if (/^https:\/\/(www\.)?twitch\.tv\//i.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('livechat:recap', async (_e, payload) => {
  if (paused()) return PAUSED;
  if (!ai.enabled()) return { ok: false, error: 'The chat recap is off, or there is no OpenRouter key (Settings).' };
  const text = await ai.summarizeChat(payload || {});
  return text ? { ok: true, text } : { ok: false, error: 'The AI did not answer. Try again.' };
});

ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('open:data', () => { config.ensureDir(); return shell.openPath(config.DATA_DIR); });
ipcMain.handle('window:minimize', () => { if (win) win.minimize(); return true; });
ipcMain.handle('window:hide', () => { if (win) win.hide(); return true; });
ipcMain.handle('window:quit', () => { quitting = true; app.quit(); return true; });
ipcMain.handle('window:pin', (_e, v) => { setAlwaysOnTop(v); return config.get().settings.alwaysOnTop; });

// ---------- wiring ----------
poller.on('status', (st) => { send('status', st); player.setLive(st.channels); if (tray) tray.rebuild(); });
poller.on('live', liveToast);
poller.on('game', gameToast);
log.subscribe((line) => send('log', line));
// Signing in starts checking (and syncs follows); signing out, or a refused refresh, stops it and clears the board.
// 'changed' also fires while a sign-in is pending, so only the transition counts.
let wasSignedIn = false;
auth.events.on('changed', (s) => {
  send('auth:changed', s);
  player.chatAuthChanged();
  if (!!s.signedIn === wasSignedIn) return;
  wasSignedIn = !!s.signedIn;
  if (s.signedIn) {
    poller.start();
    if (config.get().settings.syncFollows !== false) syncFollows();
  } else {
    poller.signedOut();
  }
});

app.whenReady().then(() => {
  if (!gotLock) return; // another copy is already running: it was shown instead
  config.load();
  store.load();
  auth.load();
  wasSignedIn = !!auth.user();
  vods.init();
  player.init({ onProgress: (id, progress) => send('twitch:progress', { id, progress }), onNowPlaying: (key) => send('twitch:nowPlaying', key) });
  createWindow();
  player.attach(() => win);
  createTray();
  poller.start();
  updater.init();
  setInterval(remindDue, 30e3);
  setInterval(() => { if (!paused() && signedIn()) schedule.get().catch(() => {}); }, 3600e3);
  setTimeout(() => { if (!paused() && signedIn()) schedule.get().catch(() => {}); }, 15e3);
  setInterval(() => { if (signedIn() && config.get().settings.syncFollows !== false) syncFollows({ quiet: true }); }, 30 * 60e3);
  setTimeout(() => { if (signedIn() && config.get().settings.syncFollows !== false) syncFollows({ quiet: true }); }, 20e3);
  const s = config.setup();
  log.info('app', `ready. v${s.version} | data: ${s.dataDir} | Twitch client ID: ${s.clientId ? 'ok' : 'missing'} | ${auth.user() ? `signed in as ${auth.user().login}` : 'signed out'} | chat recap: ${ai.enabled() ? 'on' : 'off'}${paused() ? ' | TURNED OFF (no checking)' : ''}`);
});

app.on('before-quit', () => { quitting = true; store.save(true); });
app.on('will-quit', () => require('electron').globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* keep running in tray */ });
