'use strict';
// Third-party chat emotes (7TV, BetterTTV, FrankerFaceZ): global sets plus the channel's own, as { name: url }.
// Fetched here (no page CSP to widen) and cached; the chat panel swaps matching words for the images.
const log = require('./log');

const TTL = 30 * 60e3;
const cache = new Map(); // key -> { at, map }

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? res.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

const seventv = (set) => {
  const out = {};
  for (const e of (set && set.emotes) || []) {
    const host = e.data && e.data.host;
    if (host && host.url) out[e.name] = `https:${host.url}/1x.webp`;
  }
  return out;
};
const bttv = (list) => Object.fromEntries((list || []).map((e) => [e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`]));
const ffz = (sets) => {
  const out = {};
  for (const s of Object.values(sets || {})) for (const e of s.emoticons || []) { const u = e.urls && (e.urls['1'] || e.urls[1]); if (u) out[e.name] = u.startsWith('//') ? `https:${u}` : u; }
  return out;
};

async function load(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.map;
  const map = await fn().catch((e) => { log.warn('emotes', `${key}: ${e.message}`); return {}; });
  cache.set(key, { at: Date.now(), map });
  return map;
}

const globals = () => load('global', async () => {
  const [s, b, f] = await Promise.all([
    getJson('https://7tv.io/v3/emote-sets/global'),
    getJson('https://api.betterttv.net/3/cached/emotes/global'),
    getJson('https://api.frankerfacez.com/v1/set/global'),
  ]);
  return { ...ffz(f && f.sets), ...bttv(b), ...seventv(s) };
});

const channel = (id) => load(`ch:${id}`, async () => {
  const [s, b, f] = await Promise.all([
    getJson(`https://7tv.io/v3/users/twitch/${id}`),
    getJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`),
    getJson(`https://api.frankerfacez.com/v1/room/id/${id}`),
  ]);
  return { ...ffz(f && f.sets), ...bttv(b && [...(b.channelEmotes || []), ...(b.sharedEmotes || [])]), ...seventv(s && s.emote_set) };
});

// Everything usable in a channel's chat: channel emotes win over global ones with the same name.
async function forChannel(id) {
  const [g, c] = await Promise.all([globals(), id ? channel(String(id)) : {}]);
  return { ...g, ...c };
}

module.exports = { forChannel };
