/**
 * CARTCHA server — drop-in Express router.
 *
 * Mount it in ONE line and you have a working verification endpoint:
 *
 *   const { createCartchaRouter } = require('./cartcha/router');
 *   app.use('/cartcha', createCartchaRouter({
 *     secret: process.env.CARTCHA_SECRET,          // sign success tokens (set in prod!)
 *     llm: {                                         // optional: mint keys on the fly
 *       endpoint: process.env.CARTCHA_LLM_ENDPOINT,  // any OpenAI-compatible URL
 *       key:      process.env.CARTCHA_LLM_KEY,
 *       model:    process.env.CARTCHA_LLM_MODEL,
 *     },
 *   }));
 *
 * Routes mounted (relative to the mount path):
 *   POST /challenge      -> mint a challenge        { challengeId, items, instructions, threshold }
 *   POST /verify         -> score a submission      { pass, score, threshold, token? }
 *   GET  /result?token=  -> validate a success token { valid }
 *
 * If `llm` is omitted (or the LLM call fails) the router serves the shipped, pre-validated
 * static battery, so it works with zero configuration.
 */
'use strict';

const express = require('express');
const core = require('./core');
const { initMinter } = require('./providers');

/**
 * @param {object} [options]
 * @param {string} [options.secret]    HMAC secret for success tokens (set this in production).
 * @param {number} [options.threshold] Pass threshold theta (default 0.4).
 * @param {number} [options.itemsPerChallenge] Keys per challenge (default 6).
 * @param {number} [options.ttlMs]     Challenge lifetime in ms.
 * @param {number} [options.successTtlMs] Success-token lifetime in ms.
 * @param {'static'|'llm'} [options.minter] Force a minter (defaults to static, or llm if `llm` given).
 * @param {{endpoint:string,key:string,model?:string}} [options.llm] Enable the on-the-fly LLM minter.
 * @param {(info:{minter:string,count:number})=>void} [options.onReady] Called once the key pool is loaded.
 * @returns {express.Router} A router with a `.ready` promise that resolves when the minter has loaded.
 */
function createCartchaRouter(options = {}) {
  core.configure(options);

  // Wire LLM minter config through env (the providers read env at mint time).
  if (options.llm) {
    process.env.CARTCHA_MINTER = options.minter || 'llm';
    if (options.llm.endpoint) process.env.CARTCHA_LLM_ENDPOINT = options.llm.endpoint;
    if (options.llm.key) process.env.CARTCHA_LLM_KEY = options.llm.key;
    if (options.llm.model) process.env.CARTCHA_LLM_MODEL = options.llm.model;
  } else if (options.minter) {
    process.env.CARTCHA_MINTER = options.minter;
  }

  // Static battery is active immediately; the (possibly async) minter loads in the background.
  const ready = initMinter(core)
    .then((info) => {
      if (typeof options.onReady === 'function') options.onReady(info);
      return info;
    })
    .catch((err) => {
      console.error('[cartcha] minter init failed:', err.message);
      return { minter: 'static', count: core.getKeyPool().length };
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

module.exports = { createCartchaRouter };
