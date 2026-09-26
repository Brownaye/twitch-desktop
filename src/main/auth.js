'use strict';
// Signing in with Twitch (device code flow, public client id, no client secret). The activation page opens in a
// window that shares the player's browser session (partition persist:twitch-player), so logging in there also signs
// the player in: subscriber-only VODs play, and Twitch applies your subscriptions/Turbo to its player.
// The token is what every Helix call uses (twitch.js). It lives in auth.json in the data folder, per machine.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');
const EventEmitter = require('events');
const config = require('./config');
const log = require('./log');

const FILE = path.join(config.DATA_DIR, 'auth.json');
const PARTITION = 'persist:twitch-player';
const SCOPES = 'user:read:follows chat:read chat:edit user:read:subscriptions user:read:emotes';
const SIGN_IN_FIRST = 'Sign in with Twitch first';
const TIMEOUT = 15000;
// Twitch's login page is friendlier to a plain Chrome user agent than to one that says Electron.
const CHROME_UA = () => session.defaultSession.getUserAgent().replace(/\s*Electron\/\S+/, '').replace(/\s*twitch-desktop\/\S+/i, '');

const events = new EventEmitter();
let auth = null;       // { access, refresh, expiresAt, scopes, user: { id, login, display, avatar } }
let pending = null;    // { code, uri, cancel } while signing in
let refreshing = null;

// Shown to the user as is; the poller treats it as the signed-out state.
function signedOutError() {
  const e = new Error(SIGN_IN_FIRST);
  e.code = 'SIGNED_OUT';
  return e;
}

function load() {
  const raw = config.readJson(FILE);
  auth = raw && raw.access && raw.user && raw.user.id ? raw : null;
  return auth;
}
function save() {
  if (auth) { config.writeJson(FILE, auth); return; }
  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
}

const user = () => (auth && auth.user) || null;
function status() {
  return { signedIn: !!user(), user: user(), pending: pending ? { code: pending.code } : null, clientId: !!config.clientId() };
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: config.clientId(), ...params });
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(TIMEOUT),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// A valid access token, refreshed when it is close to expiring. null when signed out (or Twitch refused the
// refresh, which signs out). Throws only on a temporary failure (offline, Twitch down), keeping the sign-in.
async function token() {
  if (!auth) return null;
  if (auth.expiresAt - Date.now() > 5 * 60e3) return auth.access;
  if (!auth.refresh) { signOutLocal('no refresh token'); return null; }
  if (!refreshing) {
    const was = auth;
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh }).then(({ status: s, json }) => {
      if (auth !== was) return auth ? auth.access : null; // signed out (or in again) meanwhile
      if (s === 200 && json.access_token) {
        Object.assign(auth, { access: json.access_token, refresh: json.refresh_token || auth.refresh, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 });
        save();
        return auth.access;
      }
      if (s === 400 || s === 401 || s === 403) { signOutLocal(`refresh refused (${s}): ${json.message || ''}`); return null; }
      throw new Error(`Twitch could not refresh the sign-in right now (${s})`);
    }).finally(() => { refreshing = null; });
  }
  return refreshing;
}

function signOutLocal(why) {
  log.warn('auth', `${why}; signed out`);
  auth = null;
  save();
  events.emit('changed', status());
}

// Helix said 401: refresh before the next call.
function invalidate() {
  if (auth) auth.expiresAt = 0;
}

// Helix as the signed-in user (the whole response body).
async function helix(pathname, params = []) {
  const t = await token();
  if (!t) throw signedOutError();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.twitch.tv/helix${pathname}${qs ? `?${qs}` : ''}`, {
    headers: { 'Client-Id': config.clientId(), Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 401) { invalidate(); throw new Error('Twitch refused the sign-in; try again'); }
  if (!res.ok) throw new Error(`Twitch API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

// Every channel you follow on Twitch (logins).
async function followed() {
  const me = user();
  if (!me) return [];
  const out = [];
  let after = null;
  do {
    const j = await helix('/channels/followed', [['user_id', me.id], ['first', '100'], ...(after ? [['after', after]] : [])]);
    out.push(...(j.data || []).map((f) => f.broadcaster_login.toLowerCase()));
    after = j.pagination && j.pagination.cursor;
  } while (after && out.length < 2000);
  return out;
}

// Start signing in: get a code, open Twitch's activation page (log in there if needed, then Activate), and wait.
async function signIn() {
  if (pending) return status();
  if (!config.clientId()) return { ...status(), error: 'This build has no Twitch client ID' };
  let res;
  let dev;
  try {
    res = await fetch('https://id.twitch.tv/oauth2/device', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId(), scopes: SCOPES }), signal: AbortSignal.timeout(TIMEOUT),
    });
    dev = await res.json().catch(() => ({}));
  } catch (e) {
    return { ...status(), error: `Could not reach Twitch (${e.message}). Check your connection and try again.` };
  }
  if (!res.ok || !dev.device_code) return { ...status(), error: `Twitch would not start a sign-in (${res.status})${dev.message ? `: ${dev.message}` : ''}` };

  const win = new BrowserWindow({
    width: 520, height: 780, title: 'Sign in to Twitch', autoHideMenuBar: true, backgroundColor: '#0e0e10',
    icon: path.join(config.ROOT, 'assets', 'icon.png'),
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setUserAgent(CHROME_UA());
  win.loadURL(dev.verification_uri).catch((e) => log.warn('auth', `activation page: ${e.message}`));

  let stopped = false;
  const finish = (err) => {
    if (stopped) return;
    stopped = true;
    pending = null;
    if (!win.isDestroyed()) win.close();
    if (err) log.warn('auth', err);
    events.emit('changed', { ...status(), error: err || null });
  };
  win.on('closed', () => { if (!stopped) setTimeout(() => finish('Sign-in window closed'), 400); }); // a last poll may still land
  pending = { code: dev.user_code, cancel: () => finish('Sign-in cancelled') };
  events.emit('changed', status());

  const deadline = Date.now() + (dev.expires_in || 1800) * 1000;
  let wait = (dev.interval || 5) * 1000;
  (async function poll() {
    while (!stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait));
      if (stopped) return;
      const { status: s, json } = await tokenRequest({ device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', scopes: SCOPES }).catch((e) => ({ status: 0, json: { message: e.message } }));
      if (s === 200 && json.access_token) {
        auth = { access: json.access_token, refresh: json.refresh_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000, scopes: json.scope || [] };
        try {
          const me = (await helix('/users')).data[0];
          auth.user = { id: me.id, login: me.login, display: me.display_name, avatar: me.profile_image_url };
        } catch (e) { auth = null; return finish(`Signed in, but could not read your account: ${e.message}`); }
        save();
        log.info('auth', `signed in as ${auth.user.login}`);
        return finish(null);
      }
      if (s === 0) continue; // offline for a moment: keep waiting
      const msg = String(json.message || '');
      if (/slow_down/.test(msg)) wait += 2000;
      else if (!/authorization_pending/.test(msg)) return finish(`Sign-in failed: ${msg || s}`);
    }
    if (!stopped) finish('Sign-in timed out');
  })().catch((e) => finish(`Sign-in failed: ${e.message}`));
  return status();
}

function cancel() {
  if (pending) pending.cancel();
  return status();
}

// Sign out of the app and of the player's session (cookies), so the player is logged out too.
async function signOut() {
  const t = auth && auth.access;
  auth = null;
  save();
  if (t) {
    fetch('https://id.twitch.tv/oauth2/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId(), token: t }), signal: AbortSignal.timeout(TIMEOUT),
    }).catch(() => {});
  }
  await session.fromPartition(PARTITION).clearStorageData({ storages: ['cookies'] }).catch(() => {});
  log.info('auth', 'signed out');
  events.emit('changed', status());
  return status();
}

// For the chat panel: log in to Twitch chat as you. null when signed out or offline.
async function chatLogin() {
  try {
    const t = await token();
    return t && user() ? { login: user().login, display: user().display, token: t } : null;
  } catch (e) {
    log.warn('auth', `chat login: ${e.message}`);
    return null;
  }
}

module.exports = { load, status, token, invalidate, followed, signIn, cancel, signOut, chatLogin, events, user, signedOutError, SIGN_IN_FIRST };
