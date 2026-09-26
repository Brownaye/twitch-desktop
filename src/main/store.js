'use strict';
// state.json (in the data folder): what this machine has seen and watched. `twitch` is the poller's memory (user
// ids, who is live, last broadcasts), `vods` your position in each VOD, `watching` live streams you left (Continue).
// Never synced between machines.
const path = require('path');
const { DATA_DIR, readJson, writeJson } = require('./config');

const STATE_FILE = path.join(DATA_DIR, 'state.json');
let state = null;
let saveTimer = null;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function load() {
  const raw = readJson(STATE_FILE);
  state = isObj(raw) ? raw : {};
  for (const k of ['twitch', 'vods', 'watching']) if (!isObj(state[k])) state[k] = {};
  return state;
}

function get() {
  if (!state) load();
  return state;
}

function save(immediate = false) {
  if (immediate) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeJson(STATE_FILE, get(), false);
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => save(true), 1500);
}

module.exports = { load, get, save };
