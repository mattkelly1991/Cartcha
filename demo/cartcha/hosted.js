/**
 * Hosted CARTCHA client (run mode: "hosted").
 *
 * In hosted mode your server does NOT mint or verify locally. Instead it proxies to the
 * managed CARTCHA API — you bring an API key, we run the LLM, the battery, and the scoring.
 * This is the zero-ops option: no LLM endpoint to wire, no battery to maintain.
 *
 * === HOW TO ENABLE ===
 *   createCartchaRouter({ mode: 'hosted', hosted: { url, key } })
 *   or env: CARTCHA_MODE=hosted, CARTCHA_HOSTED_URL=..., CARTCHA_HOSTED_KEY=...
 *
 * The managed API is expected to expose the same shape the local router does:
 *   POST {url}/challenge      -> { challengeId, items, instructions, threshold }
 *   POST {url}/verify         -> { pass, score, threshold, token? }
 *   GET  {url}/result?token=  -> { valid }
 *
 * NOTE: the managed endpoint is not live yet. Until it is, hosted mode returns a clear
 * 502 ("hosted_unavailable") rather than silently degrading — hosted is a deliberate choice.
 */
'use strict';

const DEFAULT_URL = 'https://api.cartcha.com/v1';

function createHostedClient(opts = {}) {
  const base = (opts.url || process.env.CARTCHA_HOSTED_URL || DEFAULT_URL).replace(/\/$/, '');
  const apiKey = opts.key || process.env.CARTCHA_HOSTED_KEY || '';

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  async function call(path, init) {
    const res = await fetch(base + path, init);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`hosted CARTCHA ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    base,
    configured: Boolean(apiKey),
    challenge: () => call('/challenge', { method: 'POST', headers: headers() }),
    verify: (payload) =>
      call('/verify', { method: 'POST', headers: headers(), body: JSON.stringify(payload || {}) }),
    result: (token) =>
      call('/result?token=' + encodeURIComponent(token || ''), { method: 'GET', headers: headers() }),
  };
}

module.exports = { createHostedClient, DEFAULT_URL };
