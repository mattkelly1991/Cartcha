# Integrating CARTCHA

Two pieces. Wire them up, fill in three blanks, done.

- **A. The widget** → drop into any page (one `<script>` + one `<div>`).
- **B. The endpoint** → mount into your server (one line of Express).

The only things you ever *need* to fill in:

| Blank | Where | What |
|-------|-------|------|
| **LLM endpoint** | server | Any OpenAI-compatible `/chat/completions` URL (optional — falls back to the built-in battery) |
| **LLM token** | server | API key for that endpoint |
| **Success redirect** | widget | Where to send a verified visitor (`data-redirect`) |

---

## A. Add the widget to your site

Copy `cartcha.css` and `cartcha.js` (from `demo/public/`) into your site, then:

```html
<link rel="stylesheet" href="/cartcha.css" />

<!-- The widget auto-mounts onto any element with data-cartcha. -->
<div data-cartcha
     data-api-base="/cartcha"
     data-redirect="/welcome.html"></div>

<script src="/cartcha.js"></script>
```

That's it. `data-api-base` is where your server mounted the endpoint (step B);
`data-redirect` is where a passing visitor lands (the success token is appended as
`?token=...`).

### Prefer JS config?

```html
<div id="gate"></div>
<script src="/cartcha.js"></script>
<script>
  window.cartcha.render('#gate', {
    apiBase: '/cartcha',
    redirect: '/welcome.html',
    onPass: (token) => { /* do your own thing with the token */ },
    onFail: (result) => { console.log('nope', result.score) },
  });
</script>
```

### How does an AI actually solve it?

The widget shows the challenge and exposes it for an automated agent:

```js
const c = window.cartcha.challengeData;      // { challengeId, items, instructions }
// rank each item's tokens LEAST -> MOST of item.prop, then:
await window.cartcha.submit({ [itemId]: [orderedTokens, ...] });
```

There are no "solve" buttons and no hints — a human staring at the toggle is stuck, which
is the whole point. Only something with the shared LLM prior can rank the tokens.

---

## B. Add the endpoint to your server

```bash
npm install express
```

```js
const express = require('express');
const { createCartchaRouter } = require('./cartcha/router'); // from demo/cartcha/

const app = express();
app.use('/cartcha', createCartchaRouter({ mode: 'demo' }));   // pick a mode (below)
app.listen(3000);
```

This mounts the same three routes in **every** mode:

| Method & path | Purpose |
|---------------|---------|
| `POST /cartcha/challenge` | mint a challenge |
| `POST /cartcha/verify` | score a submission → `{ pass, score, token? }` |
| `GET  /cartcha/result?token=` | validate a success token → `{ valid }` |

### Pick a run mode

The widget and routes never change — only where the minting/scoring happens.

#### 1. `demo` — built-in battery (default, zero config)

```js
app.use('/cartcha', createCartchaRouter({ mode: 'demo' }));
```
Ships the pre-validated golden battery. No network, no LLM, no key. Great for kicking the tyres.

#### 2. `self-hosted` — bring your own LLM

```js
app.use('/cartcha', createCartchaRouter({
  mode: 'self-hosted',
  secret: process.env.CARTCHA_SECRET,           // set a long random value!
  llm: {
    endpoint: process.env.CARTCHA_LLM_ENDPOINT, // any OpenAI-compatible /chat/completions URL
    key:      process.env.CARTCHA_LLM_KEY,
    model:    process.env.CARTCHA_LLM_MODEL,     // e.g. gpt-4o-mini
  },
}));
```
CARTCHA mints + validates fresh keys on **your** infrastructure using **your** LLM. Nothing
leaves your server except calls to your own endpoint. (If the LLM is unreachable it falls back
to the static battery so you never hard-break.)

#### 3. `hosted` — managed CARTCHA API *(pay-as-you-go, coming soon)*

```js
app.use('/cartcha', createCartchaRouter({
  mode: 'hosted',
  hosted: { key: process.env.CARTCHA_HOSTED_KEY },   // url defaults to the managed API
}));
```
Zero ops: bring an API key and we run the LLM, the battery, and the scoring. Your server just
proxies. *(The managed endpoint isn't live yet — until then `hosted` mode returns a clear
`502 hosted_unavailable`.)*

> Mode can also be set with `CARTCHA_MODE=demo|self-hosted|hosted` in the environment. If you
> omit `mode`, it's inferred: a hosted key → `hosted`, an `llm` block → `self-hosted`, else `demo`.

### Gate your own pages with the token

On pass, `verify` returns a one-time `token`. Trust it by validating server-side:

```js
const res = await fetch('http://localhost:3000/cartcha/result?token=' + token);
const { valid } = await res.json();
if (valid) { /* grant access */ }
```

---

## Configuration reference (all optional)

`createCartchaRouter(options)`:

| Option | Default | Meaning |
|--------|---------|---------|
| `mode` | `demo` (inferred) | `demo` · `self-hosted` · `hosted` |
| `secret` | random per-process | HMAC secret for success tokens — **set this in production** |
| `llm` | — | self-hosted: `{ endpoint, key, model }` for your minter |
| `hosted` | — | hosted: `{ url?, key }` for the managed API |
| `threshold` | `0.4` | pass if mean Kendall-τ ≥ this |
| `itemsPerChallenge` | `6` | golden keys per challenge |
| `onReady` | — | callback `({ mode, minter, count })` when ready |

All of these can also be supplied via environment variables — see `.env.example`.

> ⚠️ **Security:** the answer is never sent to the client, challenges are one-shot and
> time-boxed, and tokens are HMAC-signed. CARTCHA's strength comes from **cross-vendor**
> LLM convergence — point the minter at several independent vendors for real traffic
> (see `cartcha/providers/llm.js` and `docs/RESEARCH_NOTES.md`).
