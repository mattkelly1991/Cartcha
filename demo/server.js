/**
 * CARTCHA demo server.
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
const { createCartchaRouter } = require('./cartcha/router');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// The whole CARTCHA API in one line. Mode comes from CARTCHA_MODE (default: demo).
app.use(
  '/api',
  createCartchaRouter({
    mode: process.env.CARTCHA_MODE,
    secret: process.env.CARTCHA_SECRET,
    onReady: (info) =>
      console.log(`[cartcha] mode=${info.mode} minter=${info.minter} keys=${info.count}`),
  })
);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[cartcha] demo running at http://localhost:${PORT}`);
});

module.exports = { app, core };
