'use strict';
// config.json (in the data folder): the channels you follow, which of them are favourites (bell: listed first,
// toast when live), and settings. Nothing secret ships with the app: Twitch is "Sign in with Twitch" with a public
// client id, and the optional OpenRouter key for the chat recap is a setting.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Code and assets. In an installed build this is inside the read-only asar archive.
const ROOT = path.join(__dirname, '..', '..');

// The app's public client id from dev.twitch.tv. It identifies the app and is not a secret. TWITCH_CLIENT_ID overrides it.
const BUILT_IN_CLIENT_ID = '2w915iqawzht7yok0cbsu6ecjlqaqk';
const clientId = () => (process.env.TWITCH_CLIENT_ID || BUILT_IN_CLIENT_ID).trim();

// config.json, state.json, auth.json and app.log go in the per-user app data folder, since an installed app cannot
// write next to its code. --data-dir=<path> or TD_DATA_DIR points it elsewhere (a second profile, testing).
function dataDir() {
  const flag = process.argv.find((a) => a.startsWith('--data-dir='));
  const dir = ((flag ? flag.slice('--data-dir='.length) : '') || process.env.TD_DATA_DIR || '').trim().replace(/^"|"$/g, '');
  return dir ? path.resolve(dir) : app.getPath('userData');
}

const DATA_DIR = dataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_SETTINGS = {
  toasts: true,             // desktop toast when a favourite goes live
  alwaysOnTop: false,
  closeToTray: true,
  paused: false,            // "turned off": no polling and no API calls until turned back on
  startMinimized: false,
  pollSeconds: 60,          // how often live status is checked
  skipMuted: true,          // jump past DMCA-muted parts of VODs in the player
  chatRecap: false,         // the "What's going on?" AI recap in live chat (needs an OpenRouter key)
  openrouterKey: '',        // OpenRouter API key for the chat recap (kept in config.json on this machine only)
  openrouterModel: 'deepseek/deepseek-v4.1-flash',
  backgroundLow: true,      // streams kept loaded out of sight play at a lower quality
  cleanPlayer: true,        // hide Twitch's title bar and buttons over the video (controls still show on hover)
  audioMode: false,         // audio mode: lowest quality, picture hidden (Twitch blocks true audio-only in its embed)
  mediaKeys: true,          // keyboard media keys control the player while it is open
  followRaids: true,        // signed in: when the channel you are watching raids, the player follows
  syncFollows: true,        // signed in: channels you follow on Twitch are added automatically
  scheduleReminders: true,  // remind before favourites' scheduled streams (and any you rang the bell on)
  remindMinutes: 10,
  gameAlerts: '',           // comma separated: alert when anyone you follow is playing one of these
  ntfyTopic: '',            // set to send alerts to your phone through ntfy (empty = off)
  ntfyServer: 'https://ntfy.sh',
  twitchKeepActive: [],     // channels kept loaded in the player while live
};

let config = null;

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error(`data folder ${DATA_DIR} could not be created: ${e.message}`);
    return false;
  }
}

// null if missing. A corrupt file is renamed .bad-<time> and the app starts fresh rather than failing.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`${path.basename(file)} unreadable (${e.message}), starting fresh`);
    try { fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch { /* ignore */ }
    return null;
  }
}

// Through a temp file and a rename, so a crash mid-write cannot leave half a file. If the rename fails (Windows,
// while antivirus or a sync tool holds the file) it writes in place instead.
function writeJson(file, data, pretty = true) {
  if (!ensureDir()) return;
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  try {
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.error(`could not save ${path.basename(file)}: ${e.message}`);
    try { fs.writeFileSync(file, text); } catch { /* nothing more to try */ }
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const logins = (v) => (Array.isArray(v) ? v.filter((l) => typeof l === 'string' && l) : []);

function load() {
  ensureDir();
  const raw = readJson(CONFIG_FILE);
  const r = isObj(raw) ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, ...(isObj(r.settings) ? r.settings : {}) };
  if (!Array.isArray(settings.twitchKeepActive)) settings.twitchKeepActive = [];
  config = { settings, channels: logins(r.channels), favourites: logins(r.favourites) };
  return config;
}

function save() {
  if (config) writeJson(CONFIG_FILE, config);
}

function get() {
  if (!config) load();
  return config;
}

function update(fn) {
  const cfg = get();
  fn(cfg);
  save();
  return cfg;
}

// The OpenRouter key and model from Settings. Strings in config.json can be hand-edited, hence the String().
function openrouter() {
  const s = get().settings;
  return { key: String(s.openrouterKey || '').trim(), model: String(s.openrouterModel || '').trim() || DEFAULT_SETTINGS.openrouterModel };
}

// For Settings > About and the setup hints.
function setup() {
  const or = openrouter();
  return { clientId: !!clientId(), openrouter: !!or.key, openrouterModel: or.model, version: app.getVersion(), dataDir: DATA_DIR };
}

module.exports = { ROOT, DATA_DIR, CONFIG_FILE, load, save, get, update, clientId, openrouter, setup, ensureDir, readJson, writeJson, DEFAULT_SETTINGS };
