'use strict';
// Following raids. The player page holds the EventSub WebSocket (Electron's main process has no WebSocket) and
// hands over its session id; this side makes the channel.raid subscription for whatever live channel is playing
// (no scope needed, but EventSub over WebSocket wants a user token, so only when signed in) and, when a raid
// comes in, looks up the target's stream for the player to follow.
const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const log = require('./log');

let sessionId = null;
let watching = null;  // { id, login }
let subId = null;
let busy = Promise.resolve();

async function api(method, pathname, body) {
  const t = await auth.token();
  if (!t) return null;
  const res = await fetch(`https://api.twitch.tv/helix${pathname}`, {
    method,
    headers: { 'Client-Id': config.clientId(), Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok && res.status !== 204) { log.warn('raids', `${method} ${pathname.split('?')[0]}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`); return null; }
  return res.status === 204 ? {} : res.json();
}

// One at a time, so a quick channel switch cannot leave a stray subscription behind.
function resubscribe() {
  busy = busy.then(async () => {
    if (subId) { await api('DELETE', `/eventsub/subscriptions?id=${subId}`); subId = null; }
    if (!sessionId || !watching) return;
    const r = await api('POST', '/eventsub/subscriptions', {
      type: 'channel.raid', version: '1', condition: { from_broadcaster_user_id: watching.id }, transport: { method: 'websocket', session_id: sessionId },
    });
    subId = r && r.data && r.data[0] ? r.data[0].id : null;
    if (subId) log.info('raids', `watching ${watching.login} for raids`);
  }).catch((e) => log.warn('raids', e.message));
  return busy;
}

const enabled = () => !!auth.user() && config.get().settings.followRaids !== false;

// What is playing: a live channel's login, or null.
function watch(login) {
  const u = login && (store.get().twitch.users || {})[login];
  const want = enabled() && u && u.id ? { id: u.id, login } : null;
  if ((want && want.id) === (watching && watching.id)) return;
  watching = want;
  resubscribe();
}

function setSession(id) {
  sessionId = id || null;
  subId = null; // subscriptions die with their session
  resubscribe();
}

// The raid target's stream, as a player meta (null if they are not live after all).
async function target(login) {
  if (!login || !auth.user()) return null;
  const twitch = require('./twitch');
  const [s] = await twitch.helix('/streams', [['user_login', login]]);
  if (!s) return null;
  const [u] = await twitch.helix('/users', [['login', login]]);
  return {
    kind: 'live', login: s.user_login.toLowerCase(), display: s.user_name, avatar: u ? u.profile_image_url : null, title: s.title, game: s.game_name,
    thumb: (s.thumbnail_url || '').replace('{width}', '440').replace('{height}', '248'), link: `https://www.twitch.tv/${s.user_login}`,
    startedAt: Date.parse(s.started_at) || null, sub: `Raided in · ${s.game_name || ''}`,
  };
}

module.exports = { enabled, watch, setSession, target };
