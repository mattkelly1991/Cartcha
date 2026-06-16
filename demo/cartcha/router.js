/**
 * CARTCHA server — drop-in Express router with three run modes.
 *
 * Mount it in ONE line:
 *
 *   const { createCartchaRouter } = require('./cartcha/router');
 *   app.use('/cartcha', createCartchaRouter({ mode: 'demo' }));
 *
 * === RUN MODES ===
 *   'demo'        (default) Ship the built-in, pre-validated golden battery. Zero config,
 *                 no network, no LLM. Mints + verifies locally. Great for trying it out.
 *
 *   'self-hosted' Bring your OWN LLM. You give an OpenAI-compatible endpoint + token and
 *                 CARTCHA generates + convergence-validates fresh keys on your infrastructure.
 *                 Mints + verifies locally; nothing leaves your server except calls to your LLM.
 *                   createCartchaRouter({ mode: 'self-hosted',
 *                     llm: { endpoint, key, model } })
 *
 *   'hosted'      Use the managed CARTCHA API (pay-as-you-go — coming soon). You bring an API
 *                 key; we run the LLM, battery, and scoring. Your server just proxies.
 *                   createCartchaRouter({ mode: 'hosted', hosted: { url, key } })
 *
 * Routes mounted (relative to the mount path), identical in every mode:
 *   POST /challenge      -> mint a challenge        { challengeId, items, instructions, threshold }
 *   POST /verify         -> score a submission      { pass, score, threshold, token? }
 *   GET  /result?token=  -> validate a success token { valid }
 *
 * Mode is resolved from (in order): options.mode, CARTCHA_MODE env, inference
 * (hosted key -> hosted, llm config -> self-hosted), else 'demo'.
 */
'use strict';

const express = require('express');
const core = require('./core');
const { initMinter } = require('./providers');
const { createHostedClient } = require('./hosted');

const MODES = ['demo', 'self-hosted', 'hosted'];

function normalizeMode(m) {
  const v = String(m || '').toLowerCase().replace(/[_\s]/g, '-');
  if (v === 'selfhosted') return 'self-hosted';
  return v;
}

function resolveMode(options) {
  const explicit = normalizeMode(options.mode || process.env.CARTCHA_MODE);
  if (explicit) {
    if (!MODES.includes(explicit)) {
      throw new Error(`CARTCHA: unknown mode "${explicit}". Use one of: ${MODES.join(', ')}`);
    }
    return explicit;
  }
  if (options.hosted || process.env.CARTCHA_HOSTED_KEY) return 'hosted';
  if (options.llm || (process.env.CARTCHA_MINTER || '').toLowerCase() === 'llm') return 'self-hosted';
  return 'demo';
}

/**
 * @param {object} [options]
 * @param {'demo'|'self-hosted'|'hosted'} [options.mode] Run mode (default 'demo', or inferred).
 * @param {string} [options.secret]    HMAC secret for success tokens (set this in production).
 * @param {number} [options.threshold] Pass threshold theta (default 0.4).
 * @param {number} [options.itemsPerChallenge] Keys per challenge (default 6).
 * @param {number} [options.ttlMs]     Challenge lifetime in ms.
 * @param {number} [options.successTtlMs] Success-token lifetime in ms.
 * @param {{endpoint:string,key:string,model?:string}} [options.llm] Self-hosted: your LLM minter.
 * @param {{url?:string,key:string}} [options.hosted] Hosted: managed CARTCHA API credentials.
 * @param {(info:{mode:string,minter:string,count:number})=>void} [options.onReady] Called when ready.
 * @returns {express.Router} A router with `.mode` and a `.ready` promise.
 */
function createCartchaRouter(options = {}) {
  const mode = resolveMode(options);
  const router = mode === 'hosted' ? buildHostedRouter(options) : buildLocalRouter(options, mode);
  router.mode = mode;
  return router;
}

// --- demo + self-hosted: mint and verify on this server ---------------------
function buildLocalRouter(options, mode) {
  core.configure(options);

  // demo -> static battery; self-hosted -> your LLM minter.
  process.env.CARTCHA_MINTER = mode === 'self-hosted' ? 'llm' : 'static';
  if (options.llm) {
    if (options.llm.endpoint) process.env.CARTCHA_LLM_ENDPOINT = options.llm.endpoint;
    if (options.llm.key) process.env.CARTCHA_LLM_KEY = options.llm.key;
    if (options.llm.model) process.env.CARTCHA_LLM_MODEL = options.llm.model;
  }

  // Static battery is active immediately; the (possibly async) minter loads in the background.
  const ready = initMinter(core)
    .then((info) => {
      const out = Object.assign({ mode }, info);
      if (typeof options.onReady === 'function') options.onReady(out);
      return out;
    })
    .catch((err) => {
      console.error('[cartcha] minter init failed:', err.message);
      return { mode, minter: 'static', count: core.getKeyPool().length };
    });

  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.post('/challenge', (_req, res) => res.json(core.mintChallenge()));

  router.post('/verify', (req, res) => {
    const { challengeId, answers } = req.body || {};
    if (!challengeId) {
      return res.status(400).json({ pass: false, error: 'missing_challengeId' });
    }
    res.json(core.verifyChallenge(challengeId, answers));
  });

  router.get('/result', (req, res) => {
    res.json({ valid: core.verifySuccessToken(req.query.token) });
  });

  router.ready = ready;
  return router;
}

// --- hosted: proxy to the managed CARTCHA API -------------------------------
function buildHostedRouter(options) {
  const client = createHostedClient(options.hosted || {});

  const ready = Promise.resolve({ mode: 'hosted', minter: 'hosted', count: 0, base: client.base });
  if (typeof options.onReady === 'function') ready.then(options.onReady);
  if (!client.configured) {
    console.warn('[cartcha] hosted mode: no API key set (CARTCHA_HOSTED_KEY / hosted.key).');
  }

  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const proxy = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(502).json({ error: 'hosted_unavailable', detail: err.message });
    }
  };

  router.post('/challenge', proxy(() => client.challenge()));
  router.post('/verify', proxy((req) => client.verify(req.body)));
  router.get('/result', proxy((req) => client.result(req.query.token)));

  router.ready = ready;
  return router;
}

module.exports = { createCartchaRouter, resolveMode, MODES };
