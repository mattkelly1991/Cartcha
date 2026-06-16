# CARTCHA Demo

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

- Flip the **"I am not a human"** toggle and a challenge appears — **no buttons, no hints.**
  A human is stuck; only an LLM can rank the tokens.
- **Agent path** — an AI driving the browser reads `window.cartcha.challengeData` and calls
  `window.cartcha.submit(answers)`. On pass you reach the gated success page.

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
| `server.js` | Demo host (mounts the verifier router at `/api`) |

## Run modes

Set `CARTCHA_MODE` (or pass `mode` to `createCartchaRouter`). All three expose the same routes.

| Mode | What it does | Config |
|------|--------------|--------|
| `demo` *(default)* | Built-in pre-validated golden battery. Zero config, no network. | — |
| `self-hosted` | Bring your OWN LLM — mints + verifies locally on your infra. | `CARTCHA_LLM_ENDPOINT`, `CARTCHA_LLM_KEY`, `CARTCHA_LLM_MODEL` |
| `hosted` | Managed CARTCHA API (pay-as-you-go, **coming soon**). Your server just proxies. | `CARTCHA_HOSTED_KEY` (`CARTCHA_HOSTED_URL` optional) |

### Self-hosted: minting on the fly with your LLM

Copy `.env.example` → `.env` and set:

```
CARTCHA_MODE=self-hosted
CARTCHA_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions   # any OpenAI-compatible URL
CARTCHA_LLM_KEY=sk-...
CARTCHA_LLM_MODEL=gpt-4o-mini
```

See `cartcha/providers/llm.js` for the interface and the (important) note that real security
needs **cross-vendor** convergence + human-scatter, not one model's self-consistency. If the
LLM minter is misconfigured or fails, the server logs a warning and falls back to static.

### Hosted: managed API

```
CARTCHA_MODE=hosted
CARTCHA_HOSTED_KEY=ck_live_...
```

The managed endpoint isn't live yet, so `hosted` mode currently returns `502 hosted_unavailable`.
See `cartcha/hosted.js`.

## Tuning

`cartcha/core.js` → `CONFIG`: `itemsPerChallenge` (N), `threshold` (θ), TTLs. With N=6 and θ=0.4,
a guessing human passes ≈ 1 in 21,000; more items drive that arbitrarily low (see Exp 16c).
