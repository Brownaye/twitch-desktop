'use strict';
// Checks the followed channels every settings.pollSeconds and tells the window (status) and main.js (toasts).
// The first check after the app starts (or after signing in) never toasts, so it does not announce everyone
// already live. Signed out, it makes no API calls and the status says needsSignIn.
const EventEmitter = require('events');
const config = require('./config');
const store = require('./store');
const twitch = require('./twitch');
const auth = require('./auth');
const log = require('./log');

class Poller extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.running = null;
    this.status = { channels: [], lastPoll: null, error: null, polling: false, needsSignIn: false };
    this.first = true;
    this.lastError = null;  // the last error logged, so a long outage logs once, not every poll
    this.games = new Map(); // login -> game while live, for game alerts
  }

  // Also restarts, after pollSeconds changes or on signing in.
  start() {
    this.stop();
    if (!auth.user()) { this.signedOut(); return; }
    const secs = Math.max(20, Number(config.get().settings.pollSeconds) || 60);
    this.timer = setInterval(() => this.poll(), secs * 1000);
    this.status.needsSignIn = false;
    log.info('poller', `checking ${config.get().channels.length} channel(s) every ${secs}s${config.get().settings.paused ? ' (turned off: paused)' : ''}`);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Signed out (or never signed in): stop and clear the board.
  signedOut() {
    this.stop();
    this.first = true;
    this.lastError = null;
    this.games.clear();
    Object.assign(this.status, { channels: [], lastPoll: null, error: null, polling: false, needsSignIn: true });
    this.emit('status', this.status);
  }

  async poll() {
    if (config.get().settings.paused) return this.status; // turned off: nothing touches the network
    if (this.running) return this.running;
    this.running = this.run().catch((e) => log.error('poller', e.message)).finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    if (!auth.user()) { if (!this.status.needsSignIn || this.timer) this.signedOut(); return; }
    const logins = config.get().channels;
    Object.assign(this.status, { polling: true, needsSignIn: false });
    this.emit('status', this.status);
    const state = store.get().twitch;
    try {
      const { channels, wentLive } = await twitch.check(logins, state);
      store.save();
      if (!auth.user()) { this.signedOut(); return; } // signed out while the check was running
      if (this.lastError) { log.info('twitch', 'checking works again'); this.lastError = null; }
      Object.assign(this.status, { channels, lastPoll: Date.now(), error: null, polling: false, needsSignIn: false });
      this.emit('status', this.status);
      if (!this.first) for (const login of wentLive) this.emit('live', channels.find((c) => c.login === login));
      // Game alerts: a followed channel is now playing one of settings.gameAlerts (went live with it, or switched).
      const watch = String(config.get().settings.gameAlerts || '').split(/[,\n]/).map((g) => g.trim().toLowerCase()).filter(Boolean);
      for (const c of channels) {
        if (!c.live) { this.games.delete(c.login); continue; }
        const before = this.games.get(c.login);
        this.games.set(c.login, c.game || '');
        const g = String(c.game || '').toLowerCase();
        if (this.first || !g || before === c.game || !watch.some((w) => g.includes(w))) continue;
        this.emit('game', c);
      }
      this.first = false;
    } catch (e) {
      if (e.code === 'SIGNED_OUT' || !auth.user()) { this.signedOut(); return; }
      const msg = /fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|aborted|timeout/i.test(e.message) ? 'Could not reach Twitch (offline?)' : e.message;
      Object.assign(this.status, { lastPoll: Date.now(), error: msg, polling: false });
      if (msg !== this.lastError) { log.warn('twitch', msg === e.message ? msg : `${msg}: ${e.message}`); this.lastError = msg; }
      this.emit('status', this.status);
    }
  }
}

module.exports = new Poller();
