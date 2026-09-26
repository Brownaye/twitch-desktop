'use strict';
// Bridge for the live chat panel docked under the Twitch player (src/renderer/livechat.html).
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set(['livechat:recap', 'livechat:close', 'livechat:external', 'livechat:auth', 'livechat:emotes']);
const EVENTS = new Set(['livechat:channel', 'livechat:visible', 'livechat:authChanged']);

contextBridge.exposeInMainWorld('lc', {
  invoke: (channel, ...args) => (INVOKE.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`blocked channel ${channel}`))),
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
