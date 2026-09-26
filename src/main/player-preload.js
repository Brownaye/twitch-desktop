'use strict';
// Bridge for the docked Twitch player panel (src/renderer/player.html).
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set(['player:close', 'player:minimize', 'player:fullscreen', 'player:external', 'player:chat', 'player:size', 'player:mode', 'player:active', 'player:collapse', 'player:drag', 'player:fromStart', 'player:audio', 'player:volume', 'player:sleepEnd', 'player:step', 'player:play', 'raids:session', 'raids:target']);
const EVENTS = new Set(['player:load', 'player:pause', 'player:resume', 'player:chatState', 'player:sizeState', 'player:mode', 'player:hover', 'player:edge', 'player:keep', 'player:muted', 'player:reload', 'player:toast', 'player:prefs', 'player:key', 'player:sleepNow', 'player:chapters']);

contextBridge.exposeInMainWorld('pl', {
  invoke: (channel, ...args) => (INVOKE.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`blocked channel ${channel}`))),
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
