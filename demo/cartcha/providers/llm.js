/**
 * LLM minter (OPT-IN, plug-in point).
 *
 * Generates CARTCHA keys on the fly by asking an LLM to rank freshly-generated nonsense
 * tokens, then deriving a canonical ordering from agreement. This is the seam where the
 * project is headed: mint dynamically instead of shipping a static battery.
 *
 * === HOW TO ENABLE ===
 *   1. Copy demo/.env.example -> demo/.env and fill in:
 *        CARTCHA_MINTER=llm
 *        CARTCHA_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions   (any OpenAI-compatible URL)
 *        CARTCHA_LLM_KEY=sk-...
 *        CARTCHA_LLM_MODEL=gpt-4o-mini
 *   2. `npm start`. If anything is missing or the call fails, the server logs a warning
 *      and falls back to the static battery, so the demo never hard-breaks.
 *
 * === IMPORTANT DESIGN NOTE ===
 * CARTCHA's security comes from CROSS-VENDOR convergence (different model families agreeing),
 * not one model's self-consistency (see docs/RESEARCH_NOTES.md Exp 16a: stability is cheap,
 * cross-vendor cohesion is the real gate). This single-endpoint implementation is a STARTING
 * SCAFFOLD that filters by one model's run-to-run agreement. For production, fan `callModel`
 * out across several independent vendor endpoints and keep only keys that converge across
 * vendors AND scatter for humans (GATE-2). The interface below does not change.
 */
'use strict';

const { kendallTau } = require('../core');

function readEnv() {
  return {
    endpoint: process.env.CARTCHA_LLM_ENDPOINT,
    key: process.env.CARTCHA_LLM_KEY,
    model: process.env.CARTCHA_LLM_MODEL || 'gpt-4o-mini',
    runs: Number(process.env.CARTCHA_LLM_RUNS || 3),
    candidates: Number(process.env.CARTCHA_LLM_CANDIDATES || 24),
    targetKeys: Number(process.env.CARTCHA_LLM_KEYS || 12),
    minCohesion: Number(process.env.CARTCHA_LLM_MIN_COHESION || 0.6),
    tokensPerItem: Number(process.env.CARTCHA_LLM_TOKENS || 6),
  };
}

// Re-read at mint time (generateKeys) so config injected after module load is honoured.
let ENV = readEnv();

const PROPERTIES = [
  'ancient', 'spicy', 'magical', 'stupid', 'dangerous', 'heavy', 'loud', 'royal',
  'slippery', 'holy', 'nervous', 'bitter', 'fast', 'elegant', 'cruel', 'gloomy',
];

const ONSETS = ['', 'b', 'br', 'cl', 'dr', 'fl', 'fn', 'gr', 'kr', 'pl', 'sk', 'sn', 'sw', 'thr', 'tr', 'tw', 'vr', 'wux', 'yk', 'zz', 'qu', 'mox', 'gv', 'kt'];
const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'oo', 'ou', 'ae', 'ee', 'ya'];
const CODAS = ['', 'b', 'k', 'mb', 'nk', 'rt', 'ss', 'ld', 'sh', 'z', 'ff', 'lk', 'ng', 'x'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function nonsenseToken() {
  return pick(ONSETS) + pick(NUCLEI) + pick(CODAS) || 'mox';
}

function uniqueTokens(n) {
  const set = new Set();
  let guard = 0;
  while (set.size < n && guard++ < 500) {
    const t = nonsenseToken();
    if (t.length >= 2) set.add(t);
  }
  return [...set];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function borda(orderings) {
  const score = new Map();
  for (const o of orderings) {
    o.forEach((tok, rank) => score.set(tok, (score.get(tok) || 0) + rank));
  }
  return [...score.keys()].sort((x, y) => score.get(x) / orderings.length - score.get(y) / orderings.length);
}

function meanCohesion(orderings) {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < orderings.length; i++) {
    for (let j = i + 1; j < orderings.length; j++) {
      sum += kendallTau(orderings[i], orderings[j]);
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}

/** Call an OpenAI-compatible chat endpoint and return raw assistant text. */
async function callModel(prompt) {
  const res = await fetch(ENV.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.key}`,
    },
    body: JSON.stringify({
      model: ENV.model,
      temperature: 1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM endpoint ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseOrdering(text, tokens) {
  const set = new Set(tokens);
  // grab the first comma/space separated run that is a permutation of the token set
  const candidates = text
    .split(/\n/)
    .map((line) => line.replace(/^[^a-z]*/i, '').split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));
  for (const c of candidates) {
    if (c.length === tokens.length && c.every((t) => set.has(t)) && new Set(c).size === tokens.length) {
      return c;
    }
  }
  return null;
}

async function mintOneKey(id, prop) {
  const tokens = uniqueTokens(ENV.tokensPerItem);
  const orderings = [];
  for (let r = 0; r < ENV.runs; r++) {
    const prompt =
      `Rank these made-up words from LEAST to MOST ${prop}, using gut intuition. ` +
      `Reply with ONLY the words, comma-separated, least first:\n${shuffle(tokens).join(', ')}`;
    try {
      const ord = parseOrdering(await callModel(prompt), tokens);
      if (ord) orderings.push(ord);
    } catch (e) {
      throw e; // surface endpoint errors to caller
    }
  }
  if (orderings.length < 2) return null;
  const cohesion = meanCohesion(orderings);
  if (cohesion < ENV.minCohesion) return null;
  return { id, prop, canonical: borda(orderings), cohesion: Number(cohesion.toFixed(3)) };
}

async function generateKeys() {
  ENV = readEnv();
  if (!ENV.endpoint || !ENV.key) {
    throw new Error('CARTCHA_LLM_ENDPOINT and CARTCHA_LLM_KEY are required for the llm minter');
  }
  const keys = [];
  for (let i = 0; i < ENV.candidates && keys.length < ENV.targetKeys; i++) {
    const prop = PROPERTIES[i % PROPERTIES.length];
    const key = await mintOneKey(`${prop}-${i}`, prop);
    if (key) keys.push(key);
  }
  if (keys.length === 0) throw new Error('llm minter produced no keys above the cohesion threshold');
  return keys;
}

module.exports = { name: 'llm', generateKeys, callModel, _internals: { meanCohesion, borda, parseOrdering } };
