# Cartcha Demo

A working **reverse-CAPTCHA**: a reCAPTCHA-style widget whose toggle reads **"I am not a human."**
Click it, get a challenge, and only a Large Language Model can pass. Humans (and hand-written
scripts) are indistinguishable from random guessing and get bounced.

## Run it

```bash
cd demo
npm install
npm start
# open http://localhost:3000
```

On the page:

- **🤖 Simulate AI** — solves the challenge and you reach the gated success page.
- **🧍 Try as Human** — submits a random guess and gets denied (τ below threshold).
- **Agent path** — an AI driving the browser reads `window.cartcha.challenge` and calls
  `window.cartcha.submit(answers)`.

## How it works

1. `POST /api/challenge` mints N sets of *anchorless nonsense tokens*, each with a property
   (e.g. *ancient*). Tokens are shuffled; the canonical ordering never leaves the server.
2. The solver ranks each set **least → most** of the property.
3. `POST /api/verify` scores the submission by **mean Kendall-τ vs the canonical ordering**.
   Pass if `τ ≥ θ` (default `0.4`). LLMs converge (τ ≈ +0.8); humans scatter (τ ≈ 0).
4. A pass returns a one-time, HMAC-signed credential. Challenges are **one-shot** and
   **time-boxed** (anti-replay). The success page validates the credential via `/api/result`.

Why it works — and the experiments behind the golden keys and the threshold — is in
[`../docs/RESEARCH_NOTES.md`](../docs/RESEARCH_NOTES.md) (§6.6, Exp 16a–16c).

## What's shippable vs demo

| Part | Role |
|------|------|
| `public/cartcha.js`, `public/cartcha.css` | **Shippable widget** |
| `cartcha/core.js` | **Shippable verifier** (mint + Kendall-τ + HMAC tokens) |
| `cartcha/battery.json` | Pre-minted, convergence-validated golden keys |
| `cartcha/providers/` | Pluggable minter (static default; LLM on-the-fly opt-in) |
| `public/index.html`, `public/success.html` | Demo scaffolding only |
| `server.js`, `/api/demo-solve` | Demo host (`demo-solve` reveals the answer for the AI-simulation button — never ship it) |

## Minting on the fly with an LLM

By default the server ships the static golden battery. To generate keys at runtime from an
LLM endpoint, copy `.env.example` → `.env` and set:

```
CARTCHA_MINTER=llm
CARTCHA_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions   # any OpenAI-compatible URL
CARTCHA_LLM_KEY=sk-...
CARTCHA_LLM_MODEL=gpt-4o-mini
```

See `cartcha/providers/llm.js` for the interface and the (important) note that real security
needs **cross-vendor** convergence + human-scatter, not one model's self-consistency. If the
LLM minter is misconfigured or fails, the server logs a warning and falls back to static.

## Tuning

`cartcha/core.js` → `CONFIG`: `itemsPerChallenge` (N), `threshold` (θ), TTLs. With N=6 and θ=0.4,
a guessing human passes ≈ 1 in 21,000; more items drive that arbitrarily low (see Exp 16c).
