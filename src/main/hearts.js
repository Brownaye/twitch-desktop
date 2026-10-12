'use strict';
// Hearts: channels whose going live shows a pop-up in the player ("Switch now") while you are watching something
// else. The pop-up is held back until the stream proper has probably started, since most streams open on a
// "starting soon" screen and Twitch has no signal for when it ends:
// - by default, settings.heartWaitMinutes after the channel went live;
// - with settings.heartAiIntro and an OpenRouter key, an AI model looks at Twitch's preview picture of the stream
//   once a minute and the pop-up shows as soon as it is no longer a placeholder (or after AI_MAX_WAIT). Twitch
//   renews that picture only every few minutes, so this can trail the real start by as much.
const config = require('./config');
const ai = require('./ai');
const log = require('./log');

const AI_EVERY = 60e3;
const AI_MAX_WAIT = 15 * 60e3;

const pending = new Map(); // login -> { since, checkedAt, checking, aiDown }
let roster = () => [];     // the poller's channels
let show = () => false;    // offers the switch in the player; false if nothing is being watched

function init(opts) {
  roster = opts.roster;
  show = opts.show;
}

// From the poller: this channel has just gone live.
function wentLive(c) {
  const cfg = config.get();
  if (!c || cfg.settings.heartPopups === false || !cfg.hearts.includes(c.login)) return;
  pending.set(c.login, { since: Date.now(), checkedAt: 0, checking: false, aiDown: false });
  tick().catch((e) => log.warn('hearts', e.message));
}

const preview = (login) => `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-640x360.jpg?t=${Date.now()}`;

// Twitch's current preview frame as a data: URL; null while there is none yet (it redirects to a placeholder).
async function frame(login) {
  const res = await fetch(preview(login), { signal: AbortSignal.timeout(15000) });
  if (!res.ok || /404_preview/.test(res.url)) return null;
  return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}

// true once the AI says the placeholder is gone. null: no answer, so the fixed wait applies instead.
async function started(c) {
  try {
    const image = await frame(c.login);
    if (!image) return false;
    const intro = await ai.isIntroScreen({ streamer: c.display, title: c.title, image });
    return intro == null ? null : !intro;
  } catch (e) {
    log.warn('hearts', `preview of ${c.login}: ${e.message}`);
    return null;
  }
}

function fire(c, why) {
  pending.delete(c.login);
  log.info('hearts', `${c.login} is live (${why}): ${show(c) ? 'offered in the player' : 'nothing being watched, no pop-up'}`);
}

// Called every few seconds, and at once when a channel goes live.
async function tick() {
  const s = config.get().settings;
  if (s.paused || s.heartPopups === false) { pending.clear(); return; }
  const hearts = new Set(config.get().hearts);
  const live = new Map(roster().filter((c) => c.live).map((c) => [c.login, c]));
  for (const [login, p] of pending) {
    const c = live.get(login);
    if (!c || !hearts.has(login)) { pending.delete(login); continue; } // went offline again, or the heart was removed
    const waited = Date.now() - p.since;
    const fixed = Math.max(0, Number(s.heartWaitMinutes) || 0) * 60e3;
    if (!ai.introEnabled() || p.aiDown) {
      if (waited >= fixed) fire(c, fixed ? `${Math.round(fixed / 60e3)} min after going live` : 'just now');
      continue;
    }
    if (waited >= AI_MAX_WAIT) { fire(c, 'still looks like an intro, not waiting longer'); continue; }
    if (p.checking || Date.now() - p.checkedAt < AI_EVERY) continue;
    p.checking = true;
    p.checkedAt = Date.now();
    const ok = await started(c);
    p.checking = false;
    if (pending.get(login) !== p) continue; // dropped or replaced while the check ran
    if (ok === null) p.aiDown = true;
    else if (ok) fire(c, 'intro screen over');
  }
}

module.exports = { init, wentLive, tick };
