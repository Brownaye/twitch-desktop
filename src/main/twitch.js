'use strict';
// Twitch Helix API as the signed-in user (auth.js holds and refreshes the token). Signed out, every call throws
// auth.signedOutError().
const log = require('./log');
const config = require('./config');
const auth = require('./auth');

// The whole response body (for endpoints whose `data` is an object, like /schedule).
async function helixRaw(path, params, retry = true) {
  const t = await auth.token();
  if (!t) throw auth.signedOutError();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.twitch.tv/helix${path}${qs ? `?${qs}` : ''}`, {
    headers: { 'Client-Id': config.clientId(), Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 && retry) { auth.invalidate(); return helixRaw(path, params, false); }
  if (!res.ok) throw new Error(`Twitch API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

async function helix(path, params) {
  const data = await helixRaw(path, params);
  return Array.isArray(data.data) ? data.data : [];
}

const LOGIN_RE = /^[a-z0-9_]{3,25}$/i;

// Logins from free text: names, @names, twitch.tv URLs, separated by spaces, commas or new lines.
function parseLogins(text) {
  const out = [];
  for (let raw of String(text || '').split(/[\s,]+/)) {
    raw = raw.trim();
    if (!raw) continue;
    const m = raw.match(/twitch\.tv\/([a-z0-9_]+)/i);
    const login = (m ? m[1] : raw).toLowerCase().replace(/^@/, '');
    if (LOGIN_RE.test(login) && !out.includes(login)) out.push(login);
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function thumb(url) {
  return url ? url.replace('{width}', '440').replace('{height}', '248') + `?t=${Math.floor(Date.now() / 300000)}` : null;
}

// Helix VOD durations look like "3h2m1s".
function parseVodDuration(d) {
  const m = String(d || '').match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000 : 0;
}

const CHANNEL_INFO_EVERY = 10 * 60e3; // offline title/category as set on the channel
const VOD_EVERY = 60 * 60e3;          // last broadcast per offline channel
const VODS_PER_POLL = 5;              // spread the per-channel VOD lookups over several polls
const USER_REFRESH = 24 * 3600e3;     // avatars and display names

// Channel title/category for everyone (one call) and, a few at a time, each offline channel's last VOD
// so the board can say when they were last live even if the app was not running when they stopped.
async function refreshOffline(logins, state, now) {
  const ids = logins.map((l) => state.users[l]).filter((u) => u && u.id);
  if (now - (state.channelsAt || 0) > CHANNEL_INFO_EVERY) {
    for (const group of chunk(ids, 100)) {
      const rows = await helix('/channels', group.map((u) => ['broadcaster_id', u.id]));
      for (const r of rows) state.channels[String(r.broadcaster_login).toLowerCase()] = { title: r.title, game: r.game_name };
    }
    state.channelsAt = now;
  }
  state.vodAt = state.vodAt || {};
  const due = logins
    .filter((l) => !state.live[l] && state.users[l] && state.users[l].id && now - (state.vodAt[l] || 0) > VOD_EVERY)
    .slice(0, VODS_PER_POLL);
  for (const l of due) {
    state.vodAt[l] = now;
    const [v] = await helix('/videos', [['user_id', state.users[l].id], ['type', 'archive'], ['first', '1']]);
    if (!v) continue;
    const startedAt = Date.parse(v.created_at);
    const endedAt = startedAt + parseVodDuration(v.duration);
    const known = state.last[l];
    if (!known || endedAt > known.endedAt + 5 * 60e3) state.last[l] = { startedAt, endedAt, title: v.title, game: null, peak: null };
  }
}

// One check of every followed channel. Updates `state` (kept in state.json) and returns the roster the window
// draws, plus the channels that have just gone live.
async function check(logins, state) {
  state.live = state.live || {};
  state.users = state.users || {};
  state.last = state.last || {};         // last stream we know of per channel (seen ending, or from its VOD)
  state.channels = state.channels || {}; // channel title/category, shown while offline
  const now = Date.now();

  const stale = logins.filter((l) => !state.users[l] || (!state.users[l].unknown && now - (state.users[l].at || 0) > USER_REFRESH));
  for (const group of chunk(stale, 100)) {
    const users = await helix('/users', group.map((l) => ['login', l]));
    for (const u of users) state.users[u.login.toLowerCase()] = { id: u.id, display: u.display_name, avatar: u.profile_image_url, at: now };
    for (const l of group) if (!state.users[l]) state.users[l] = { unknown: true, display: l };
  }

  const nowLive = new Map();
  for (const group of chunk(logins, 100)) {
    const streams = await helix('/streams', [['first', '100'], ...group.map((l) => ['user_login', l])]);
    for (const s of streams) nowLive.set(String(s.user_login).toLowerCase(), s);
  }

  const wentLive = [];
  for (const login of logins) {
    const s = nowLive.get(login);
    const prev = state.live[login];
    if (s) {
      state.live[login] = {
        id: s.id, title: s.title, game: s.game_name, gameId: s.game_id, startedAt: s.started_at, viewers: s.viewer_count,
        thumb: s.thumbnail_url, tags: s.tags || [], language: s.language, mature: !!s.is_mature,
        peak: Math.max(s.viewer_count || 0, prev && prev.id === s.id ? prev.peak || 0 : 0), missed: 0,
      };
      if (!prev) wentLive.push(login);
    } else if (prev) {
      // Helix occasionally omits a live channel for a single poll. Give one poll of grace before
      // declaring the stream over so the board does not flicker.
      if (!prev.missed) { state.live[login] = { ...prev, missed: 1 }; continue; }
      delete state.live[login];
      state.last[login] = { startedAt: Date.parse(prev.startedAt) || now, endedAt: now, title: prev.title, game: prev.game, peak: prev.peak || prev.viewers || null };
    }
  }
  for (const l of Object.keys(state.live)) if (!logins.includes(l)) delete state.live[l]; // unfollowed

  await refreshOffline(logins, state, now).catch((e) => log.warn('twitch', `offline info: ${e.message}`));

  const channels = logins.map((l) => {
    const u = state.users[l] || {};
    const live = state.live[l];
    const info = state.channels[l] || {};
    const last = state.last[l] || null;
    const base = { login: l, id: u.id || null, display: u.display || l, avatar: u.avatar || null, url: `https://www.twitch.tv/${l}`, unknown: !!u.unknown };
    if (live) {
      return { ...base, live: true, title: live.title, game: live.game, gameId: live.gameId, viewers: live.viewers, peak: live.peak, startedAt: live.startedAt,
        thumb: thumb(live.thumb), tags: live.tags || [], language: live.language, mature: live.mature };
    }
    return { ...base, live: false, title: info.title || (last && last.title) || '', game: info.game || (last && last.game) || '',
      lastStartedAt: last ? last.startedAt : null, lastEndedAt: last ? last.endedAt : null, lastPeak: last ? last.peak : null };
  });
  log.info('twitch', `${nowLive.size}/${logins.length} live`);
  return { channels, wentLive };
}

// Which of these logins exist (for adding channels).
async function lookupUsers(logins) {
  const out = [];
  for (const group of chunk(logins, 100)) out.push(...await helix('/users', group.map((l) => ['login', l])));
  return out.map((u) => ({ login: u.login.toLowerCase(), id: u.id, display: u.display_name, avatar: u.profile_image_url }));
}

module.exports = { helix, helixRaw, parseLogins, parseVodDuration, check, lookupUsers, chunk };
