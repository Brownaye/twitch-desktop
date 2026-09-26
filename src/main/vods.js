'use strict';
// Twitch VODs: past broadcasts for every followed channel, and how far into each one you got (played in
// src/main/player.js). Progress lives in state.json under `vods` ({ [videoId]: { pos, dur, at, done, hidden, meta } }).
// Live streams watched for a while and then left live under `watching` ({ [login]: { login, ..., startedAt, leftAt } });
// both feed the Continue tab.
const config = require('./config');
const store = require('./store');
const twitch = require('./twitch');
const auth = require('./auth');
const log = require('./log');

const CACHE_FOR = 10 * 60e3;
const PER_CHANNEL = 20;   // Helix max is 100; 20 covers a couple of weeks for daily streamers
const PARALLEL = 6;
const DONE_AT = 0.95;     // counts as watched past 95%

let cache = null;         // { at, count, list }

function progress() {
  const s = store.get();
  s.vods = s.vods || {};
  return s.vods;
}

// The followed channels, with the user ids the poller has already looked up.
function channels() {
  const users = store.get().twitch.users || {};
  const fav = new Set(config.get().favourites);
  const out = [];
  for (const login of config.get().channels) {
    const u = users[login];
    if (u && u.id) out.push({ login, id: u.id, display: u.display || login, avatar: u.avatar || null, fav: fav.has(login) });
  }
  return out;
}

// Helix gives "%{width}x%{height}"; a VOD still recording has a placeholder thumb.
function thumb(url) {
  return url && !/_404\//.test(url) ? url.replace('%{width}', '320').replace('%{height}', '180') : null;
}

async function list({ refresh = false } = {}) {
  if (!auth.user()) throw auth.signedOutError();
  const chans = channels();
  if (!refresh && cache && Date.now() - cache.at < CACHE_FOR && cache.count === chans.length) return decorate();
  const all = [];
  const queue = [...chans];
  const errors = [];
  async function worker() {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const rows = await twitch.helix('/videos', [['user_id', c.id], ['type', 'archive'], ['first', String(PER_CHANNEL)]]);
        for (const v of rows) {
          all.push({
            id: v.id, login: c.login, display: c.display, avatar: c.avatar,
            title: v.title, createdAt: Date.parse(v.created_at), dur: twitch.parseVodDuration(v.duration) / 1000,
            thumb: thumb(v.thumbnail_url), views: v.view_count, url: v.url, sub: !!v.viewable && v.viewable !== 'public',
          });
        }
      } catch (e) {
        if (e.code === 'SIGNED_OUT') { queue.length = 0; throw e; }
        errors.push(`${c.login}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  // Every channel failed (offline, Twitch down): say so, and keep the list we had.
  if (chans.length && errors.length >= chans.length) throw new Error(`Could not load VODs (${errors[0].replace(/^[^:]+: /, '')})`);
  if (errors.length) log.warn('vods', `${errors.length} channel(s) failed, e.g. ${errors[0]}`);
  all.sort((a, b) => b.createdAt - a.createdAt);
  cache = { at: Date.now(), count: chans.length, list: all };
  log.info('vods', `${all.length} VODs from ${chans.length} channels`);
  return decorate();
}

// The VOD Twitch is recording of a stream that is live now (null if the channel keeps no VODs, or hides them).
// startedAt (ms) guards against picking up the previous broadcast.
async function currentBroadcast(login, startedAt) {
  const c = channels().find((x) => x.login === login);
  if (!c) throw new Error(`${login} is not in your Twitch channels`);
  const [v] = await twitch.helix('/videos', [['user_id', c.id], ['type', 'archive'], ['first', '1']]);
  if (!v || (startedAt && Date.parse(v.created_at) < startedAt - 15 * 60e3)) return null;
  return { id: v.id, title: v.title, url: v.url, dur: twitch.parseVodDuration(v.duration) / 1000 };
}

// DMCA-muted parts of a VOD (red on Twitch's seekbar) as merged [{ start, end }] in seconds. Helix does not have
// them; Twitch's own GraphQL API does, with the web client id (same as the Skip Muted for Twitch extension).
const GQL = 'https://gql.twitch.tv/gql';
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const mutedCache = new Map(); // id -> { at, list }
async function mutedSegments(id) {
  const hit = mutedCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_FOR) return hit.list;
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Client-Id': WEB_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query($id: ID!) { video(id: $id) { muteInfo { mutedSegmentConnection { nodes { offset duration } } } } }', variables: { id: String(id) } }),
  });
  if (!res.ok) throw new Error(`gql ${res.status}`);
  const json = await res.json();
  const nodes = (((((json || {}).data || {}).video || {}).muteInfo || {}).mutedSegmentConnection || {}).nodes || [];
  const list = [];
  for (const r of nodes.map((n) => ({ start: n.offset, end: n.offset + n.duration })).filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)) {
    const last = list[list.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end); else list.push(r);
  }
  mutedCache.set(id, { at: Date.now(), list });
  return list;
}

// A VOD's chapters (the games played, from Twitch's GraphQL API): [{ start, dur, game, art }] in seconds.
const chapterCache = new Map();
async function chapters(id) {
  const hit = chapterCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_FOR) return hit.list;
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Client-Id': WEB_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($id: ID!) { video(id: $id) { moments(momentRequestType: VIDEO_CHAPTER_MARKERS, first: 50) { edges { node { description positionMilliseconds durationMilliseconds details { ... on GameChangeMomentDetails { game { displayName boxArtURL(width: 40, height: 53) } } } } } } } }',
      variables: { id: String(id) },
    }),
  });
  if (!res.ok) throw new Error(`gql ${res.status}`);
  const json = await res.json();
  const edges = (((((json || {}).data || {}).video || {}).moments || {}).edges) || [];
  const list = edges.map(({ node: n }) => {
    const g = n.details && n.details.game;
    return { start: Math.round(n.positionMilliseconds / 1000), dur: Math.round(n.durationMilliseconds / 1000), game: (g && g.displayName) || n.description, art: (g && g.boxArtURL) || null };
  }).sort((a, b) => a.start - b.start);
  chapterCache.set(id, { at: Date.now(), list });
  return list;
}

function decorate() {
  const p = progress();
  return { at: cache.at, vods: cache.list.map((v) => ({ ...v, progress: p[v.id] || null })) };
}

function setWatched(id, done) {
  const p = progress();
  if (done) p[id] = { ...(p[id] || {}), done: true, at: Date.now() };
  else delete p[id];
  store.save();
  return p[id] || null;
}

// Drop progress for VODs Twitch has deleted (it keeps them 60 days at most).
function prune() {
  const p = progress();
  const cutoff = Date.now() - 60 * 24 * 3600e3;
  for (const [id, v] of Object.entries(p)) if ((v.at || 0) < cutoff) delete p[id];
}

// Record a position reading from the player (src/main/player.js).
function record(id, pos, dur) {
  const p = progress();
  const prev = p[id] || {};
  p[id] = { ...prev, pos: Math.round(pos), dur: Math.round(dur), at: Date.now(), done: !!prev.done || pos / dur >= DONE_AT, hidden: false };
  store.save();
  return p[id];
}

// Where to start a VOD: a few seconds before where it was left, unless finished or restarting.
function resumeAt(id, restart) {
  const p = progress()[id];
  return !restart && p && p.pos && !p.done ? Math.max(0, p.pos - 5) : 0;
}

// Mark a VOD as started the moment it is opened, so it shows a progress state straight away. `meta` (title,
// channel, thumbnail) is kept so the Continue tab can show it after it drops out of the VOD list.
function touch(id, dur, meta) {
  const p = progress();
  const info = meta ? { title: meta.title, login: meta.login, display: meta.display, avatar: meta.avatar, thumb: meta.thumb, url: meta.link } : null;
  if (p[id]) {
    if (info && info.login) { p[id].meta = { ...(p[id].meta || {}), ...info }; store.save(); }
    return null;
  }
  p[id] = { pos: 0, dur, at: Date.now(), done: false, meta: info };
  store.save();
  return p[id];
}

// ---------- Continue ----------
const KEEP_LIVE = 3 * 24 * 3600e3; // how long a left live stream stays in Continue

// A live stream you watched for a while and then left (switched away, closed the player, quit).
function noteLive(meta, leftAt) {
  const s = store.get();
  s.watching = s.watching || {};
  s.watching[meta.login] = {
    login: meta.login, display: meta.display, avatar: meta.avatar, title: meta.title, thumb: meta.thumb, link: meta.link,
    startedAt: meta.startedAt || null, leftAt,
  };
  store.save();
}

function forget({ kind, id, login }) {
  const s = store.get();
  if (kind === 'live') { if (s.watching) delete s.watching[login]; }
  else { const p = progress(); if (p[id]) p[id].hidden = true; }
  store.save();
}

// Unfinished VODs (at least a minute in) and recently left live streams, newest first.
function continueList() {
  const s = store.get();
  const byId = new Map((cache ? cache.list : []).map((v) => [v.id, v]));
  const out = [];
  for (const [id, e] of Object.entries(progress())) {
    if (e.done || e.hidden || !(e.pos >= 60)) continue;
    const v = byId.get(id) || {};
    const m = e.meta || {};
    const item = {
      kind: 'vod', id, pos: e.pos, dur: Math.max(e.dur || 0, v.dur || 0), at: e.at,
      title: m.title || v.title, login: m.login || v.login, display: m.display || v.display, avatar: m.avatar || v.avatar,
      thumb: m.thumb || v.thumb || null, url: m.url || v.url,
    };
    if (item.login) out.push(item);
  }
  const cutoff = Date.now() - KEEP_LIVE;
  for (const [login, w] of Object.entries(s.watching || {})) {
    if (w.leftAt < cutoff) { delete s.watching[login]; continue; }
    out.push({ kind: 'live', ...w, at: w.leftAt });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 40);
}

// What comes after a VOD, asked when playback nears its end: its length now (it may still be recording and have
// grown), the channel's live stream if any (and whether this VOD is that stream's recording), and the channel's
// next broadcast after this one (a stream that dropped and restarted is split across VODs).
async function continuation(id) {
  const [v] = await twitch.helix('/videos', [['id', String(id)]]);
  if (!v) return null;
  const created = Date.parse(v.created_at);
  const dur = twitch.parseVodDuration(v.duration) / 1000;
  const [stream] = await twitch.helix('/streams', [['user_id', v.user_id]]);
  const live = stream ? {
    login: stream.user_login, display: stream.user_name, title: stream.title, game: stream.game_name, viewers: stream.viewer_count,
    startedAt: Date.parse(stream.started_at), thumb: (stream.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360') || null,
  } : null;
  const recording = !!live && Math.abs(live.startedAt - created) < 15 * 60e3;
  const rows = await twitch.helix('/videos', [['user_id', v.user_id], ['type', 'archive'], ['first', '10']]);
  const after = rows.map((r) => ({ id: r.id, title: r.title, url: r.url, created: Date.parse(r.created_at), dur: twitch.parseVodDuration(r.duration) / 1000 }))
    .filter((r) => r.created > created + 60e3).sort((a, b) => a.created - b.created)[0];
  // Only a broadcast that began soon after this one ended counts as its next part.
  const next = after && after.created - (created + dur * 1000) < 3 * 3600e3 ? after : null;
  return { dur, live, recording, next };
}

// The VOD of a particular broadcast (started at startedAt, ms), for catching up on a live stream you left.
async function broadcastFor(login, startedAt) {
  const c = channels().find((x) => x.login === login);
  if (!c) throw new Error(`${login} is not in your Twitch channels`);
  const rows = await twitch.helix('/videos', [['user_id', c.id], ['type', 'archive'], ['first', '10']]);
  const v = startedAt ? rows.find((r) => Math.abs(Date.parse(r.created_at) - startedAt) < 15 * 60e3) : rows[0];
  return v ? { id: v.id, title: v.title, url: v.url, dur: twitch.parseVodDuration(v.duration) / 1000 } : null;
}

function init() {
  prune();
}

module.exports = { init, list, setWatched, record, resumeAt, touch, currentBroadcast, mutedSegments, noteLive, forget, continueList, broadcastFor, continuation, chapters };
