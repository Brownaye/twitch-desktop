'use strict';
// Tiny logger that mirrors lines to the console, to app.log in the data folder and to any subscribed renderer.
// Anything that looks like a token or key is redacted first, since logs end up pasted into bug reports.
const fs = require('fs');
const listeners = new Set();
const buffer = [];
const MAX = 300;
const MAX_FILE = 1024 * 1024; // app.log rolls over to app.log.old past 1 MB

let file = null;

const REDACT = [
  [/(Bearer|OAuth)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/oauth:[A-Za-z0-9]+/gi, 'oauth:[redacted]'],
  [/((?:access_token|refresh_token|device_code|client_secret|token|api[_-]?key|key)["']?\s*[=:]\s*["']?)[A-Za-z0-9._~+/-]{8,}/gi, '$1[redacted]'],
  [/sk-or-[A-Za-z0-9-]+/g, 'sk-or-[redacted]'],
];

function redact(s) {
  let out = String(s);
  for (const [re, to] of REDACT) out = out.replace(re, to);
  return out;
}

function setFile(p) {
  file = p;
  try { if (fs.statSync(file).size > MAX_FILE) fs.renameSync(file, `${file}.old`); } catch { /* no file yet */ }
}

function emit(level, scope, msg) {
  const line = { ts: Date.now(), level, scope, msg: redact(msg instanceof Error ? msg.message : msg) };
  buffer.push(line);
  if (buffer.length > MAX) buffer.shift();
  const text = `[${scope}] ${line.msg}`;
  try { if (level === 'error') console.error(text); else console.log(text); } catch { /* stdout closed (EPIPE) */ }
  if (file) fs.appendFile(file, `${new Date(line.ts).toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`, () => {});
  for (const fn of listeners) { try { fn(line); } catch (_) { /* ignore */ } }
}

module.exports = {
  info: (scope, msg) => emit('info', scope, msg),
  warn: (scope, msg) => emit('warn', scope, msg),
  error: (scope, msg) => emit('error', scope, msg),
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  recent: () => buffer.slice(),
  setFile,
};
