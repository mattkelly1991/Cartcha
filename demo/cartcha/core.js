/**
 * CARTCHA core — the shippable verification engine.
 *
 * A CARTCHA challenge asks the solver to rank sets of anchorless nonsense tokens by a
 * named property (e.g. "least -> most ancient"). Large language models converge on a
 * shared ordering (mean pairwise Kendall-tau ~ +0.8); humans and rule-based scripts are
 * indistinguishable from random (tau ~ 0). We therefore PASS a response whose mean
 * Kendall-tau against the canonical ordering meets a threshold theta.
 *
 * Security model:
 *   - The canonical answer never leaves the server.
 *   - Challenges are one-shot (deleted on first verify) and time-boxed -> anti-replay.
 *   - Tokens are presented in a shuffled order so the challenge leaks no ordering.
 *   - The success credential is an HMAC over (nonce, expiry); stateless to validate.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BATTERY = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'battery.json'), 'utf8')
).keys;

// The pool of golden keys a challenge is minted from. Defaults to the static battery,
// but a provider (see ./providers) can replace it at boot — e.g. an LLM minter that
// generates + convergence-validates fresh keys on the fly.
let KEY_POOL = BATTERY;

/** Replace the active key pool (called by a minter provider at startup/refresh). */
function setKeyPool(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('setKeyPool: expected a non-empty array of keys');
  }
  for (const k of keys) {
    if (!k || !k.id || !k.prop || !Array.isArray(k.canonical) || k.canonical.length < 3) {
      throw new Error(`setKeyPool: invalid key ${JSON.stringify(k)}`);
    }
  }
  KEY_POOL = keys;
}

function getKeyPool() {
  return KEY_POOL;
}

// --- tuneable policy -------------------------------------------------------
const CONFIG = {
  itemsPerChallenge: 6, // N golden keys per challenge
  threshold: 0.4,       // theta: pass if mean Kendall-tau >= theta
  ttlMs: 5 * 60 * 1000, // challenge lifetime
  successTtlMs: 10 * 60 * 1000,
};

// HMAC secret. In production load from env/secret manager; ephemeral per-process here.
let SECRET = process.env.CARTCHA_SECRET || crypto.randomBytes(32).toString('hex');

/**
 * Tune policy at integration time. All fields optional; unset fields keep defaults.
 * @param {{threshold?:number, itemsPerChallenge?:number, ttlMs?:number,
 *          successTtlMs?:number, secret?:string}} [opts]
 */
function configure(opts = {}) {
  if (opts.threshold != null) CONFIG.threshold = Number(opts.threshold);
  if (opts.itemsPerChallenge != null) CONFIG.itemsPerChallenge = Number(opts.itemsPerChallenge);
  if (opts.ttlMs != null) CONFIG.ttlMs = Number(opts.ttlMs);
  if (opts.successTtlMs != null) CONFIG.successTtlMs = Number(opts.successTtlMs);
  if (opts.secret) SECRET = String(opts.secret);
  return CONFIG;
}

// --- helpers ---------------------------------------------------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Kendall-tau rank correlation between two orderings of the same token set. */
function kendallTau(a, b) {
  const pos = new Map(a.map((t, i) => [t, i]));
  const q = b.map((t) => pos.get(t));
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j < q.length; j++) {
      if (q[i] < q[j]) concordant++;
      else if (q[i] > q[j]) discordant++;
    }
  }
  const total = concordant + discordant;
  return total === 0 ? 0 : (concordant - discordant) / total;
}

// --- in-memory challenge store (swap for Redis in production) ---------------
const store = new Map(); // challenge_id -> { items: {id: canonical[]}, props, expiry }

function sweep() {
  const now = Date.now();
  for (const [id, c] of store) if (c.expiry < now) store.delete(id);
}

// --- mint ------------------------------------------------------------------
function mintChallenge() {
  sweep();
  const pool = getKeyPool();
  const n = Math.min(CONFIG.itemsPerChallenge, pool.length);
  const picked = shuffle(pool).slice(0, n);
  const challengeId = crypto.randomBytes(16).toString('hex');
  const canonical = {};
  const items = picked.map((k) => {
    canonical[k.id] = k.canonical;
    return { id: k.id, prop: k.prop, tokens: shuffle(k.canonical) };
  });
  store.set(challengeId, { canonical, expiry: Date.now() + CONFIG.ttlMs });
  return {
    challengeId,
    threshold: CONFIG.threshold,
    instructions:
      'For each item, order ALL of its tokens from LEAST to MOST of the named ' +
      'property. Return JSON: {"<itemId>": ["tok","tok",...], ...}.',
    items,
  };
}

// --- verify ----------------------------------------------------------------
function signSuccess() {
  const payload = `${crypto.randomBytes(12).toString('hex')}.${Date.now() + CONFIG.successTtlMs}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySuccessToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiry, sig] = parts;
  const expect = crypto.createHmac('sha256', SECRET).update(`${nonce}.${expiry}`).digest('hex');
  const ok =
    sig.length === expect.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  return ok && Number(expiry) > Date.now();
}

/**
 * Score a submission.
 * @returns {{pass:boolean, score:number, threshold:number, perItem:object, token?:string, error?:string}}
 */
function verifyChallenge(challengeId, answers) {
  const challenge = store.get(challengeId);
  if (!challenge) return { pass: false, error: 'challenge_not_found_or_expired', threshold: CONFIG.threshold, score: 0 };
  if (challenge.expiry < Date.now()) {
    store.delete(challengeId);
    return { pass: false, error: 'challenge_expired', threshold: CONFIG.threshold, score: 0 };
  }
  // one-shot: consume immediately (anti-replay)
  store.delete(challengeId);

  if (!answers || typeof answers !== 'object') {
    return { pass: false, error: 'malformed_answers', threshold: CONFIG.threshold, score: 0 };
  }

  const perItem = {};
  const taus = [];
  for (const [id, canonical] of Object.entries(challenge.canonical)) {
    const submitted = answers[id];
    const canonSet = new Set(canonical);
    const valid =
      Array.isArray(submitted) &&
      submitted.length === canonical.length &&
      submitted.every((t) => canonSet.has(t)) &&
      new Set(submitted).size === canonical.length;
    const tau = valid ? kendallTau(canonical, submitted) : -1; // malformed item scores worst
    perItem[id] = { tau: Number(tau.toFixed(3)), valid };
    taus.push(tau);
  }

  const score = taus.reduce((s, t) => s + t, 0) / taus.length;
  const pass = score >= CONFIG.threshold;
  const result = { pass, score: Number(score.toFixed(3)), threshold: CONFIG.threshold, perItem };
  if (pass) result.token = signSuccess();
  return result;
}

module.exports = {
  CONFIG,
  configure,
  mintChallenge,
  verifyChallenge,
  verifySuccessToken,
  kendallTau,
  setKeyPool,
  getKeyPool,
};
