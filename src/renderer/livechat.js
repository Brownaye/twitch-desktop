/* global lc */
'use strict';
// Live chat under the player: a Twitch IRC connection, as you when signed in (Settings > Twitch account; then you
// can type), otherwise anonymous and read-only. Plus a "What's going on?" toggle that asks the AI for a one-line
// recap of the last few minutes of chat.

const RECAP_WINDOW = 5 * 60e3; // how much chat a recap covers
const READY_EVERY = 3 * 60e3;  // the button counts down this long, then lights up: a fresh recap is worth asking for
const MAX_MSGS = 250;          // messages kept on screen
const MIN_FOR_RECAP = 4;       // fewer than this = "quiet"

const $ = (id) => document.getElementById(id);
const msgsEl = $('msgs');
let ws = null;
let channel = null;         // { login, display, title, game }
let joined = null;          // login currently joined
let retry = 0;
let buffer = [];            // recent messages, oldest first: { t, name, text } (last RECAP_WINDOW only)
let history = [];           // recaps for this channel, newest first: { text, from, to, count, quiet }
let joinedAt = Date.now();
let readyAt = Date.now() + READY_EVERY;
let stick = true;           // follow new messages unless the user scrolled up
let rate = [];              // timestamps of recent messages, for msgs/min
let me = null;              // { login, display, token } when signed in
let myTags = {};            // our USERSTATE in the joined channel: colour, badges, display name
let extra = {};             // 7TV / BTTV / FFZ emotes for this channel: { name: url }
const authReady = lc.invoke('livechat:auth').then((a) => { me = a; renderCompose(); }).catch(() => {});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---------- IRC ----------
function connect() {
  if (ws && ws.readyState <= 1) return;
  setState('connecting');
  ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  ws.onopen = () => {
    retry = 0;
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    if (me) { ws.send(`PASS oauth:${me.token}`); ws.send(`NICK ${me.login}`); }
    else { ws.send('PASS SCHMOOPIIE'); ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`); }
    joined = null;
    if (channel) join(channel.login);
  };
  ws.onmessage = (e) => String(e.data).split('\r\n').filter(Boolean).forEach(handle);
  ws.onclose = () => {
    joined = null;
    setState('reconnecting');
    setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };
}

function join(login) {
  if (!ws || ws.readyState !== 1) return;
  if (joined && joined !== login) ws.send(`PART #${joined}`);
  if (joined !== login) ws.send(`JOIN #${login}`);
  joined = login;
}

function parse(line) {
  let tags = {};
  let rest = line;
  if (rest[0] === '@') {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest[0] === ':') { const sp = rest.indexOf(' '); prefix = rest.slice(1, sp); rest = rest.slice(sp + 1); }
  const ti = rest.indexOf(' :');
  const trailing = ti >= 0 ? rest.slice(ti + 2) : '';
  const params = (ti >= 0 ? rest.slice(0, ti) : rest).split(' ');
  return { tags, prefix, command: params[0], params: params.slice(1), trailing };
}

function handle(line) {
  const m = parse(line);
  if (m.command === 'PING') { ws.send(`PONG :${m.trailing}`); return; }
  if (m.command === 'NOTICE' && /authentication failed|improperly formatted auth/i.test(m.trailing)) {
    // The token was refused: carry on anonymously rather than not at all.
    me = null; renderCompose(); addNotice('Could not sign in to chat, reading anonymously', ''); ws.close(); return;
  }
  const chan = (m.params[0] || '').replace('#', '');
  if (m.command === 'ROOMSTATE' || (m.command === '366')) { if (chan === joined) setState('live'); return; }
  if (chan && chan !== joined) return;
  if (m.command === 'USERSTATE') { myTags = m.tags; return; }
  if (m.command === 'NOTICE') { addNotice(m.trailing, ''); return; }
  if (m.command === 'PRIVMSG') {
    let text = m.trailing;
    const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
    if (action) text = action[1];
    const name = m.tags['display-name'] || m.prefix.split('!')[0];
    addMessage({ id: m.tags.id, name, login: m.prefix.split('!')[0], color: m.tags.color, badges: m.tags.badges || '', emotes: m.tags.emotes || '', text, action: !!action });
  } else if (m.command === 'USERNOTICE') {
    addNotice(m.tags['system-msg'] || '', m.trailing);
  } else if (m.command === 'CLEARMSG') {
    const el = msgsEl.querySelector(`[data-id="${CSS.escape(m.tags['target-msg-id'] || '')}"]`);
    if (el) el.classList.add('deleted');
  } else if (m.command === 'CLEARCHAT' && m.trailing) {
    msgsEl.querySelectorAll(`[data-login="${CSS.escape(m.trailing)}"]`).forEach((el) => el.classList.add('deleted'));
  }
}

function remember(name, text) {
  const now = Date.now();
  buffer.push({ t: now, name, text });
  while (buffer.length && (now - buffer[0].t > RECAP_WINDOW || buffer.length > 4000)) buffer.shift();
}

// ---------- rendering ----------
const PALETTE = ['#ff7a7a', '#7ab8ff', '#7affa1', '#ffb86b', '#d58bff', '#6be4ff', '#ff8bd0', '#c8ff6b', '#ffd86b', '#9f9bff'];
function nameColor(color, login) {
  if (color) {
    const n = parseInt(color.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    if (lum > 0.35) return color;
  }
  let h = 0;
  for (const ch of login || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function badgeHtml(badges) {
  const out = [];
  if (/broadcaster\//.test(badges)) out.push('<span class="bd bc" title="Broadcaster">B</span>');
  if (/moderator\//.test(badges)) out.push('<span class="bd mod" title="Moderator">M</span>');
  if (/vip\//.test(badges)) out.push('<span class="bd vip" title="VIP">V</span>');
  if (/(subscriber|founder)\//.test(badges)) out.push('<span class="bd sub" title="Subscriber">S</span>');
  return out.join('');
}

// 7TV / BTTV / FFZ emotes are plain words in the message; swap the ones we know for their images.
function wordsHtml(text) {
  return text.split(/(\s+)/).map((w) => (extra[w] ? `<img class="emote" src="${esc(extra[w])}" alt="${esc(w)}" title="${esc(w)}">` : esc(w))).join('');
}

// Twitch emote positions count Unicode code points, not UTF-16 units.
function textHtml(text, emotes) {
  const chars = Array.from(text);
  const spans = [];
  for (const part of emotes.split('/').filter(Boolean)) {
    const [id, ranges] = part.split(':');
    for (const r of (ranges || '').split(',')) { const [a, b] = r.split('-').map(Number); spans.push({ a, b, id }); }
  }
  spans.sort((x, y) => x.a - y.a);
  let html = '', i = 0;
  for (const s of spans) {
    if (s.a < i) continue;
    html += wordsHtml(chars.slice(i, s.a).join(''));
    const name = chars.slice(s.a, s.b + 1).join('');
    html += `<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(s.id)}/default/dark/1.0" alt="${esc(name)}" title="${esc(name)}">`;
    i = s.b + 1;
  }
  return html + wordsHtml(chars.slice(i).join(''));
}

function append(el) {
  msgsEl.appendChild(el);
  while (msgsEl.children.length > MAX_MSGS) msgsEl.firstChild.remove();
  if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
  else $('below').hidden = false;
}

function addMessage(m) {
  remember(m.name, m.text);
  rate.push(Date.now());
  const el = document.createElement('div');
  el.className = `msg${m.action ? ' action' : ''}`;
  el.dataset.id = m.id || '';
  el.dataset.login = m.login;
  const c = nameColor(m.color, m.login);
  el.innerHTML = `${badgeHtml(m.badges)}<span class="who" style="color:${esc(c)}">${esc(m.name)}</span><span class="sep">${m.action ? ' ' : ': '}</span><span class="txt"${m.action ? ` style="color:${esc(c)}"` : ''}>${textHtml(m.text, m.emotes)}</span>`;
  append(el);
}

function addNotice(system, text) {
  if (!system) return;
  remember('[event]', `${system}${text ? ` - ${text}` : ''}`);
  const el = document.createElement('div');
  el.className = 'msg notice';
  el.innerHTML = `<span class="txt">${esc(system)}</span>${text ? `<div class="sub">${esc(text)}</div>` : ''}`;
  append(el);
}

function addDivider(text) {
  const el = document.createElement('div');
  el.className = 'divider';
  el.textContent = text;
  append(el);
}

function setState(s) {
  const el = $('h-state');
  el.className = `h-state ${s}`;
  el.textContent = s === 'live' ? '' : s === 'connecting' ? 'connecting...' : s === 'reconnecting' ? 'reconnecting...' : '';
}

msgsEl.addEventListener('scroll', () => {
  stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 40;
  if (stick) $('below').hidden = true;
});
$('below').addEventListener('click', () => { stick = true; msgsEl.scrollTop = msgsEl.scrollHeight; $('below').hidden = true; });

// ---------- recap ----------
function renderRecap(fresh = false) {
  const text = $('recap-text');
  const latest = history[0];
  if (!latest) {
    text.className = 'recap-text quiet';
    text.textContent = '';
    $('recap-when').textContent = '';
  } else {
    text.className = `recap-text${latest.quiet ? ' quiet' : ''}${fresh ? ' fresh' : ''}`;
    text.textContent = latest.text;
    $('recap-when').textContent = `${clock(latest.from)}-${clock(latest.to)}${latest.count ? ` \u00b7 ${latest.count} msgs` : ''}`;
  }
  const older = history.slice(1);
  const more = $('recap-more');
  more.hidden = !older.length;
  more.textContent = $('recap-history').hidden ? `Earlier (${older.length})` : 'Hide earlier';
  $('recap-history').innerHTML = older.map((h) => `<li><span class="t">${clock(h.from)}</span><span class="${h.quiet ? 'quiet' : ''}">${esc(h.text)}</span></li>`).join('');
}

$('recap-more').addEventListener('click', () => { const h = $('recap-history'); h.hidden = !h.hidden; renderRecap(); });

let recapping = false;
async function recap() {
  if (!channel || recapping) return;
  const to = Date.now();
  const batch = buffer.filter((b) => to - b.t <= RECAP_WINDOW);
  const from = batch.length ? Math.max(batch[0].t, joinedAt) : Math.max(to - RECAP_WINDOW, joinedAt);
  const forLogin = channel.login;
  if (batch.filter((b) => b.name !== '[event]').length < MIN_FOR_RECAP) {
    history.unshift({ text: batch.length ? 'Chat has been quiet.' : 'Nothing in chat yet.', from, to, count: batch.length, quiet: true });
    renderRecap(true);
    return;
  }
  recapping = true;
  $('recap').classList.add('thinking');
  $('b-wgo').classList.add('thinking');
  tickButton();
  $('recap-text').className = 'recap-text quiet';
  $('recap-text').textContent = `Reading ${batch.length} messages...`;
  const r = await lc.invoke('livechat:recap', {
    streamer: channel.display, title: channel.title, game: channel.game, minutes: Math.max(1, Math.round((to - from) / 60e3)),
    messages: batch.map(({ name, text }) => ({ name, text })),
    previous: (history.find((h) => !h.quiet) || {}).text || null,
  }).catch((e) => ({ ok: false, error: e.message }));
  recapping = false;
  $('recap').classList.remove('thinking');
  $('b-wgo').classList.remove('thinking');
  if (!channel || channel.login !== forLogin) return;
  history.unshift(r.ok && r.text ? { text: r.text, from, to, count: batch.length } : { text: r.error || 'Could not get a recap this time.', from, to, count: batch.length, quiet: true });
  history = history.slice(0, 30);
  readyAt = Date.now() + READY_EVERY;
  renderRecap(true);
  tickButton();
}

// The toggle: opening asks for a fresh recap (unless one is under 30 s old); closing just hides the card.
function toggleRecap(force) {
  const card = $('recap');
  const open = force === undefined ? card.hidden : force;
  $('b-wgo').classList.toggle('on', open);
  if (!open) { card.hidden = true; return; }
  card.hidden = false;
  card.classList.remove('opening');
  void card.offsetWidth;
  card.classList.add('opening');
  if (!history[0] || Date.now() - history[0].to > 30e3) recap(); else renderRecap();
}
$('b-wgo').addEventListener('click', () => toggleRecap());
$('b-again').addEventListener('click', () => recap());

// Counting down: a ring fills and shows the time left. Ready: the button lights up and says so. Nothing is
// fetched until it is clicked; clicking early still works, it just covers less new chat.
const RING = 2 * Math.PI * 7.5;
$('wgo-fg').style.strokeDasharray = String(RING);
function tickButton() {
  const b = $('b-wgo');
  const left = readyAt - Date.now();
  const ready = left <= 0;
  b.classList.toggle('ready', ready && !recapping);
  b.classList.toggle('counting', !ready);
  $('wgo-fg').style.strokeDashoffset = String(RING * Math.max(0, Math.min(1, left / READY_EVERY)));
  const secs = Math.ceil(Math.max(0, left) / 1000);
  $('wgo-label').textContent = recapping ? 'Reading chat...' : ready ? "What's been going on?" : `Recap in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  b.title = ready ? 'A fresh recap of the chat is ready to ask for' : 'Counting down to the next recap (click to ask now anyway)';
}

setInterval(() => {
  const now = Date.now();
  while (rate.length && now - rate[0] > 60e3) rate.shift();
  $('h-rate').textContent = joined ? `${rate.length}/min` : '';
  tickButton();
}, 1000);

// ---------- wiring ----------
lc.on('livechat:channel', (c) => {
  const same = channel && channel.login === c.login;
  channel = c;
  $('h-name').textContent = c.display;
  $('b-wgo').hidden = !c.recap; // only with the recap switched on and an OpenRouter key (Settings)
  if (same) return;
  msgsEl.innerHTML = '';
  buffer = [];
  history = [];
  rate = [];
  joinedAt = Date.now();
  readyAt = joinedAt + READY_EVERY;
  stick = true;
  toggleRecap(false);
  $('below').hidden = true;
  $('recap-history').hidden = true;
  document.body.classList.remove('switch');
  void document.body.offsetWidth;
  document.body.classList.add('switch');
  addDivider(`Joined ${c.display}'s chat`);
  extra = {};
  lc.invoke('livechat:emotes', c.id).then((map) => { if (channel && channel.login === c.login) extra = map || {}; }).catch(() => {});
  renderRecap();
  myTags = {};
  if (ws && ws.readyState === 1) join(c.login); else authReady.then(connect);
});

let hiddenAt = null;
lc.on('livechat:visible', (v) => {
  if (!v) { hiddenAt = hiddenAt || Date.now(); return; }
  document.body.classList.remove('enter');
  void document.body.offsetWidth;
  document.body.classList.add('enter');
  if (hiddenAt && Date.now() - hiddenAt > 60e3) addDivider(`Back at ${clock(Date.now())}`);
  hiddenAt = null;
});

// ---------- typing (signed in) ----------
function renderCompose() {
  $('compose').hidden = !me;
  $('compose-off').hidden = !!me;
  $('b-ext').title = me ? 'Open chat on twitch.tv' : 'Open chat on twitch.tv (to type)';
}

function say(text) {
  if (!me || !joined || !ws || ws.readyState !== 1) return false;
  ws.send(`PRIVMSG #${joined} :${text}`);
  // Twitch does not echo your own messages back, so show it straight away.
  addMessage({ id: '', name: myTags['display-name'] || me.display, login: me.login, color: myTags.color, badges: myTags.badges || '', emotes: '', text, action: false });
  return true;
}

$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('say');
  const text = input.value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (say(text)) { input.value = ''; stick = true; msgsEl.scrollTop = msgsEl.scrollHeight; }
});

lc.on('livechat:authChanged', async () => {
  me = await lc.invoke('livechat:auth').catch(() => null);
  myTags = {};
  renderCompose();
  if (ws) { retry = 0; ws.close(); } // reconnects as the new identity
});

$('b-close').addEventListener('click', () => lc.invoke('livechat:close'));
$('b-ext').addEventListener('click', () => channel && lc.invoke('livechat:external', `https://www.twitch.tv/popout/${channel.login}/chat`));
