'use strict';
// Bridge for the main window. Every channel must be listed here or the window gets "blocked channel".
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:bootstrap', 'app:pause', 'settings:update', 'poll:now',
  'channels:add', 'channels:remove', 'channels:favourite', 'follows:sync', 'schedule:get', 'schedule:remind', 'stats:get', 'ntfy:test',
  'auth:status', 'auth:signIn', 'auth:cancel', 'auth:signOut',
  'twitch:vods', 'twitch:play', 'twitch:watched', 'twitch:nowPlaying', 'twitch:keep', 'twitch:fromStart', 'twitch:continue', 'twitch:catchUp', 'twitch:forget',
  'open:external', 'open:data',
  'window:minimize', 'window:hide', 'window:quit', 'window:pin',
]);

const EVENTS = new Set(['status', 'log', 'settings:changed', 'channels:changed', 'ui:view', 'twitch:progress', 'twitch:nowPlaying', 'auth:changed']);

contextBridge.exposeInMainWorld('tw', {
  invoke: (channel, ...args) => (INVOKE.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`blocked channel ${channel}`))),
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return () => {};
    const wrapped = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
