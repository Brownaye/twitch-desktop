'use strict';
// Stream schedules: each followed channel's Twitch schedule (Helix /schedule, as the signed-in user), the next 7 days, kept in
// state.json under `schedule` and refreshed every 3 hours. Reminders go out settings.remindMinutes before a
// scheduled start, for favourites automatically and for any stream you rang the bell on.
const config = require('./config');
const store = require('./store');
const twitch = require('./twitch');
const auth = require('./auth');
const log = require('./log');

const EVERY = 3 * 3600e3;
const AHEAD = 7 * 86400e3;
const PARALLEL = 6;
let running = null;

function data() {
  const s = store.get();
  s.schedule = s.schedule || { at: 0, items: [], remind: [], reminded: [] };
  return s.schedule;
}

async function refresh() {
  if (running) return running;
  if (!auth.user()) throw auth.signedOutError();
  running = (async () => {
    const users = store.get().twitch.users || {};
    const chans = config.get().channels.map((l) => ({ login: l, ...(users[l] || {}) })).filter((c) => c.id);
    const now = Date.now();
    const items = [];
    const queue = [...chans];
    const errors = [];
    async function worker() {
      for (let c = queue.shift(); c; c = queue.shift()) {
        let rows;
        try { rows = await twitch.helixRaw('/schedule', [['broadcaster_id', c.id], ['first', '12']]); } catch (e) {
          if (e.code === 'SIGNED_OUT') { queue.length = 0; throw e; }
          if (!/404/.test(e.message)) errors.push(`${c.login}: ${e.message}`);
          continue;
        }
        const segs = (rows && rows.data && rows.data.segments) || [];
        for (const seg of segs) {
          const start = Date.parse(seg.start_time);
          if (!Number.isFinite(start) || start < now - 3600e3 || start > now + AHEAD || seg.canceled_until) continue;
          items.push({
            id: seg.id, login: c.login, display: c.display || c.login, avatar: c.avatar || null, start, end: Date.parse(seg.end_time) || null,
            title: seg.title || '', game: (seg.category && seg.category.name) || '', recurring: !!seg.is_recurring,
          });
        }
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    // Offline or Twitch down: keep the schedule we had rather than replace it with nothing.
    if (chans.length && errors.length >= chans.length) throw new Error(`schedule not refreshed, e.g. ${errors[0]}`);
    if (errors.length) log.warn('schedule', `${errors.length} channel(s) failed, e.g. ${errors[0]}`);
    items.sort((a, b) => a.start - b.start);
    const d = data();
    d.items = items;
    d.at = now;
    const ids = new Set(items.map((i) => i.id));
    d.remind = (d.remind || []).filter((id) => ids.has(id));
    d.reminded = (d.reminded || []).filter((k) => ids.has(k.split('@')[0]));
    store.save();
    log.info('schedule', `${items.length} scheduled stream(s) in the next 7 days from ${new Set(items.map((i) => i.login)).size} channel(s)`);
    return d;
  })().finally(() => { running = null; });
  return running;
}

async function get({ force = false } = {}) {
  const d = data();
  if (!auth.user()) return { at: d.at, items: d.items, remind: d.remind || [], needsSignIn: true, error: auth.SIGN_IN_FIRST };
  if (force || Date.now() - d.at > EVERY) await refresh().catch((e) => { if (e.code !== 'SIGNED_OUT') log.warn('schedule', e.message); });
  return { at: d.at, items: d.items, remind: d.remind || [] };
}

function setRemind(id, on) {
  const d = data();
  const set = new Set(d.remind || []);
  if (on) set.add(id); else set.delete(id);
  d.remind = [...set];
  store.save();
  return d.remind;
}

// Streams due a reminder now (each start time reminded once), marked as done.
function due() {
  const s = config.get().settings;
  if (s.scheduleReminders === false) return [];
  const lead = Math.max(1, Number(s.remindMinutes) || 10) * 60e3;
  const d = data();
  const fav = new Set(config.get().favourites);
  const want = new Set(d.remind || []);
  const done = new Set(d.reminded || []);
  const now = Date.now();
  const out = [];
  for (const it of d.items || []) {
    const key = `${it.id}@${it.start}`;
    if (done.has(key) || !(fav.has(it.login) || want.has(it.id))) continue;
    if (it.start - lead <= now && now < it.start + 5 * 60e3) { out.push(it); done.add(key); }
  }
  if (out.length) { d.reminded = [...done]; store.save(); }
  return out;
}

module.exports = { get, refresh, setRemind, due };
