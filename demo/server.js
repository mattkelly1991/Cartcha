/**
 * Cartcha demo server.
 *
 * Hosts the shippable widget (public/) and the verification API. The widget + cartcha/
 * are the real product; index.html / success.html are demo scaffolding.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

// --- tiny .env loader (no dependency) --------------------------------------
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const core = require('./cartcha/core');
const { initMinter } = require('./cartcha/providers');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Mint a fresh challenge.
app.post('/api/challenge', (_req, res) => {
  res.json(core.mintChallenge());
});

// Verify a submission. On pass returns a one-time success token.
app.post('/api/verify', (req, res) => {
  const { challengeId, answers } = req.body || {};
  if (!challengeId) return res.status(400).json({ pass: false, error: 'missing_challengeId' });
  res.json(core.verifyChallenge(challengeId, answers));
});

// Validate a success token (used by the gated success page).
app.get('/api/result', (req, res) => {
  res.json({ valid: core.verifySuccessToken(req.query.token) });
});

// DEMO ONLY: reveal the canonical answer so the UI can simulate an AI solving it.
// This exists purely so a human visitor can watch a pass happen. Never ship it.
app.post('/api/demo-solve', (req, res) => {
  const answer = core.demoSolve((req.body || {}).challengeId);
  if (!answer) return res.status(404).json({ error: 'challenge_not_found_or_expired' });
  res.json({ answers: answer });
});

const PORT = Number(process.env.PORT || 3000);

initMinter(core)
  .then(({ minter, count }) => {
    app.listen(PORT, () => {
      console.log(`[cartcha] minter=${minter} keys=${count}`);
      console.log(`[cartcha] demo running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[cartcha] failed to initialise minter:', err);
    process.exit(1);
  });
