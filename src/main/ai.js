'use strict';
// OpenRouter, used for one thing: the live chat recap ("What's going on?") in the player's chat panel. Off unless
// turned on in Settings with the user's own OpenRouter key.
const config = require('./config');
const log = require('./log');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
let warnedNoKey = false;

function enabled() {
  return config.get().settings.chatRecap === true && !!config.openrouter().key;
}

async function chat(messages, { maxTokens = 400, temperature = 0.3, timeoutMs = 45000 } = {}) {
  const { key, model } = config.openrouter();
  if (!key) {
    if (!warnedNoKey) { warnedNoKey = true; log.warn('ai', 'no OpenRouter key in Settings: chat recap disabled'); }
    return null;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // DeepSeek V4 is a reasoning model; turn thinking off so short replies are not eaten by reasoning tokens.
    const body = { model, messages, max_tokens: maxTokens, temperature, reasoning: { enabled: false } };
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Twitch Desktop' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error('ai', `OpenRouter ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return typeof content === 'string' ? content.trim() : null;
  } catch (e) {
    log.error('ai', `request failed: ${e.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

const SYSTEM = 'You write terse, useful text for a Twitch desktop app. Never use markdown, emoji, or preamble. British English.';

// What a stream's chat was on about over the last few minutes. `messages` are [{ name, text }] oldest first;
// `previous` is the last recap, for continuity.
async function summarizeChat({ streamer, title, game, minutes, messages, previous }) {
  if (!enabled()) return null;
  const lines = messages.slice(-400).map((m) => `${m.name}: ${String(m.text).slice(0, 160)}`).join('\n');
  const prompt = `You are catching someone up on a Twitch stream's live chat. Below is everything chat said in the last ${minutes} minutes.\n\nStreamer: ${streamer}\nStream title: ${title || 'unknown'}\nCategory: ${game || 'unknown'}\n${previous ? `Your previous recap: ${previous}\n` : ''}\nChat:\n${lines}\n\nIn one short sentence (max 20 words), say what chat has been talking about or reacting to: the topic, a moment that set them off, a running joke, the mood. Be concrete. Emote names like KEKW, LUL, OMEGALUL, Pog, monkaS, Sadge tell you the reaction (laughing, hype, tension, sad). Do not list usernames unless one person is the story. Do not repeat the previous recap unless it is still going on. Reply with the sentence only.`;
  const out = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 120, temperature: 0.4, timeoutMs: 30000 });
  return out ? out.replace(/^["']+|["']+$/g, '').split('\n')[0].trim() : null;
}

module.exports = { enabled, summarizeChat };
