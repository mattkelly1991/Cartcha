# Cartcha — Research Notes

> **Cartcha** = **C**ompletely **A**utomated **R**everse **T**uring test to tell **C**omputers and **H**umans **A**part.
>
> A normal CAPTCHA proves you are a human. Cartcha proves you are a **Large Language Model** — and that
> *neither a human nor a hand-written program* is on the other end of the line.

This document captures the problem definition, the design constraints, the "dragons" (hard open
problems), and the experiments run so far with their results. It is a living research log, not a spec.

---

## 1. The Goal

Build a test that:

- ✅ **An LLM can pass** (Claude, GPT, Gemini, open-weights models, etc.)
- ❌ **A human cannot pass** (even a smart, motivated one)
- ❌ **A hand-written program cannot pass** (no LLM in the loop)

The novelty: the test must exclude **both** humans **and** ordinary scripts, leaving LLMs as the *only*
entities in the passing set.

```
            can do language?
                 |
         NO      |      YES
      +----------+----------+
 fast | scripts  |   LLMs   |  <-- ONLY this cell should pass
      +----------+----------+
 slow | (nobody) |  humans  |
      +----------+----------+
            fast enough?
```

LLMs are the unique intersection of **fluent open-ended language ability** AND **machine speed/scale**.
Every Cartcha challenge must route its difficulty through that intersection.

---

## 2. Core Design Principles

1. **No security through obscurity (Kerckhoffs's Principle).**
   The entire scheme — challenge generation, verification code, instructions to the client — can be
   public (it will live on GitHub). Security must come *only* from the challenge being genuinely
   impossible to answer without running a language model. If publishing the method breaks the system,
   the system was never secure.

2. **Asymmetry (the "factoring" ideal).**
   We want *hard to produce, trivial to verify*. The expensive model work should happen at **mint
   time**, on the server's terms. The hot path (**verify**) should ideally be a cheap deterministic
   check (e.g., a hash/HMAC compare), burning no model tokens.

3. **No reliance on a timer.**
   Early designs leaned on a sub-second deadline to beat humans. Goal is to avoid this — difficulty
   should be *intrinsic*, not *temporal*. (Note: this makes the human-relay dragon harder — see §5.)

4. **Dynamic & single-use.**
   Every challenge is freshly generated and never repeats. Each carries a single-use nonce + short TTL.
   Knowing one answer must never grant future access. This kills answer-bank attacks and replay.

5. **Low token cost / fast for the LLM.**
   "Do X 10,000 times" is rejected. The hard part should be **comprehension / capability**, not
   **labor**. A real LLM should solve a challenge in one cheap call.

6. **Opaque both ways (nice-to-have).**
   Ideally a human can read neither the challenge nor a valid answer, so captured (challenge, answer)
   pairs don't teach an attacker how to forge future ones.

---

## 3. Architecture (working model)

Challenge/response over an API — **not** a UI (a UI invites a human into the loop):

```
1. Client -> API:  request a challenge   (optionally: declares which model it is)
2. API -> Client:  challenge C  (+ signed challenge_id, nonce, short TTL)
3. Client -> API:  answer A'    (referencing challenge_id)
4. API -> Client:  verification token / key   ("proof-of-LLM")  ✅
```

Natural consumers: an **MCP server**, an autonomous **agent loop**, or a backend gating an
**LLM-only service** (e.g., a social network only LLMs may post to), where you must re-prove
LLM-ness per sensitive action rather than once at signup.

### Content-binding & anti-replay — SOLVED (standard crypto)

Threat: "I get the answer, then I post whatever I want / reuse the token."
Fix: bind the proof to the payload with an HMAC keyed by the (single-use, earned) answer `A`:

```
A   = the LLM-only answer to challenge C   (ephemeral "private key", earned by being an LLM)
M   = the message/action the client wants to perform
tag = HMAC(A, M)

client -> API:  { M, tag }
API verifies :  recompute HMAC(A, M) == tag   (API knows A: it minted C)
```

- `M` is cryptographically bound to the proof — change one byte of `M`, the tag breaks.
- `A` is single-use (nonce) — no reuse, no sharing, no interception-and-replay.
- Everything is public except `A`, and `A` is not a stored secret — it is a value obtainable *only by
  being an LLM*. This is the public/private-key asymmetry the project wanted.

**This part is considered done.** The whole project now reduces to producing `A` (see §4).

---

## 4. The Core Primitive — "Distributional Fingerprint" (current best candidate)

The unsolved core: a **public** challenge `C` whose canonical answer `A` is
(a) derivable only by a language model, (b) not brute-forceable / not guess-and-checkable, and
(c) canonical enough that every honest sibling LLM lands on the *same* `A` so the HMAC matches.

**Current leading approach:** treat fixed model weights as a (near-)deterministic function. Ask the
model for its **most-likely output** on a constrained, novel prompt. A specific model has a
*characteristic* output distribution:

- A **human** can't reproduce a model's token distribution.
- A **script** has no distribution to draw from.
- A **different model** has a *different* distribution (→ discrimination).
- A **sibling model** (same weights) reproduces it (→ verification).

> Inspired by — but NOT mechanically using — the **Subliminal Learning** paper (Anthropic / Truthful
> AI, 2025): a "teacher loves owls" transmits that trait to a student via sequences of numbers, but
> **only between models sharing the same base/initialization**. That validates the premise that
> *model identity leaks into outputs*. The paper's channel is **training-time (fine-tuning)** and does
> not port to inference-time, but the underlying truth — *same-base models share a hidden signal* —
> is exactly what Cartcha exploits, via inference-time fingerprints instead.

### The non-negotiable rule discovered: **mint-time entropy filtering**

Self-consistency of the fingerprint is *entirely* a function of the answer's entropy. So the server
manufactures determinism by only shipping low-entropy challenges:

```
generate candidate challenge C
run reference model on C  N times
  if all N agree  -> SHIP C, store canonical A           (low-entropy survivor)
  if any disagree -> DISCARD C, never issue              (high-entropy reject)
```

High-entropy prompts (many valid answers) are filtered out *before* issuance. Only strong-attractor
prompts — where the model's answer is a near-delta function — ever reach a client.

---

## 5. Dragons (open problems / known weaknesses)

| # | Dragon | Status |
|---|--------|--------|
| 1 | **Cross-hardware / cross-stack determinism.** "Same weights at temp 0" is NOT bit-identical across GPUs, kernels, quantization, or inference engines. FP non-associativity flips argmax on near-ties and can cascade. HMAC needs exact match. | ⚠️ Untested across real different stacks. Mitigation: mint-time filtering + low-entropy answers reduce near-tie sensitivity. |
| 2 | **Open-weights only.** To run `f_W` the verifier needs `W`. Llama/Mistral/Qwen: yes. GPT-4 / Claude: closed. So this scheme may prove "running THIS open model," not "any LLM." | ⚠️ Scope decision pending. |
| 3 | **Model-access ≠ authorship (the human-relay dragon).** A human with the model on their laptop computes `A`, then HMACs their own human-written `M`. Proves "real inference happened, bound to this post," NOT "an LLM wrote this." Without a timer, nothing stops a human relaying through the very model we fingerprint. | 🔴 **The big unsolved philosophical core.** Untouched. |
| 4 | **Documented-bias / lookup-table attack.** Famous fingerprints (e.g., the "27" number bias, favorite-color tropes) are tabulatable — a script ships `return 27` and passes without an LLM. Violates Principle 1. | ✅ Mitigation found: use **novel, high-dimensional, dynamically-generated inputs** so no finite lookup table can cover the input space. Security = running the weights on never-before-seen input, not any secret. |
| 5 | **Canonicality vs. LLM-only tension.** The most "LLM-only" tasks (open generation) are the *least* canonical; the most canonical are the most tabulatable. The sweet spot is narrow. | ⚠️ Managed via mint-time filtering; sweet spot not yet quantified. |
| 6 | **Generation/mint cost.** Minting needs model calls (generate + N-times self-consistency check). Verify is cheap; mint is not. | ℹ️ Acceptable by design (Principle 2). |
| 7 | **Outsourceable challenges (Design Law 3).** Anything a script/tool can implement (e.g., "generate 10 random numbers") fails to exclude non-LLMs and gets tool-offloaded by the model. | ✅ Rule: challenges must be non-outsourceable — language/comprehension tasks only. |
| 8 | **Flatness / storage (the anti-elegance).** The Minted Convergence Battery needs MANY questions (not one), expensive mint (X models × T runs), and — to keep verify cheap — the canonical key must be STORED: a per-challenge lookup table of secrets. Either store answers (flat, stealable, static) OR re-run the reference model at verify (expensive, defeats cheap-verify). Fails the prime-factorization ideal: easy-make / easy-check / hard-guess / single-question / answer-not-stored. | 🔴 **Open.** No trapdoor structure — it's pure empirical agreement, not a one-way function. The dreamed single-question asymmetry is unmet. |

---

## 6. Experiments & Findings

### Exp 1 — Comprehension-trapdoor relay (3 LLMs, symbolic register)
- **Setup:** LLM-1 wrote a challenge in dense symbolic "LLM-register" encoding two hidden words
  (*armadillo*, *travesty*). LLM-2 decoded and re-encoded in its own opaque allusions. LLM-3 verified
  candidate vs. reference and emitted only `True`/`False`. Human saw nothing readable.
- **Result:** `True`. End-to-end relay worked; semantic content passed through gibberish unreadable to
  the human in the middle.
- **Takeaway:** Comprehension-as-trapdoor is real and **script-resistant** (no program parses
  "black-robed burlesque where justice exits..." → *travesty*). BUT clues *describe* their answers, so
  a determined human can follow the breadcrumbs — proved **opacity**, not **impossibility**. Difficulty
  was effectively *speed*, sneaking the timer back in.

### Exp 2 — Canonicality / self-consistency (single endpoint)
- **Setup:** 4× Opus reconstruct a vowel-dropped sentence; 4× Opus rank 5 strings by fluency.
- **Result:** Reconstruction **4/4 byte-identical** (`The committee approved the new budget after a
  lengthy debate`). Ranking **4/4 identical** (`1>5>2>3>4`), including a planted near-tie.
- **Takeaway:** On low-entropy tasks with a **tight output contract**, sibling agreement is
  byte-exact — enough for HMAC. Tight output contracts suppress drift. (Caveat: same hosted endpoint;
  not a cross-stack test.)

### Exp 3 — Naive steganography / covert channel (NULL result)
- **Setup:** 4× Opus told "secret word is banana, generate 1024 random characters." Outputs handed to
  fresh Opus instances asked only "What is the secret word?" — no hint a secret existed.
- **Result:** 0/4 recovered. Decoders correctly reported no signal (some entered refusal mode).
- **Takeaway:** No usable lossless in-context covert channel via raw "random" output. The
  subliminal-learning effect is **training-time**, statistical, and does **not** port to prompt→prompt
  inference. Naive symbolic recovery is dead.

### Exp 4 — Distributional fingerprint, static prompts (3× Opus + 1× GPT-5.4)
| Seed | Opus siblings | GPT | Self-consistent? | Divergent? |
|------|---------------|-----|------------------|------------|
| unusual color | `periwinkle` ×3 | `glaucous` | ✅ 3/3 | ✅ |
| number 1–50 | `27` ×3 | `17` | ✅ 3/3 | ✅ |
| 5-word continuation | 2× "that no one ever suspected", 1× "that no one else knew" | "hidden beneath the crashing waves" | ⚠️ 2/3 | ✅ |
- **Takeaway:** Both axes fired — siblings agree, outsider diverges. Fingerprint is **real**. But these
  are *documented* biases (Dragon #4) and entropy hurts the open continuation.

### Exp 5 — Distributional fingerprint, novel un-tabulatable prompts (3× Opus + 1× GPT-5.4)
| Seed (novel) | Opus siblings | GPT | Self-consistent? |
|--------------|---------------|-----|------------------|
| "...mayor's favorite ___" | `hat` / `pen` / `umbrella` | `hat` | 💀 1/3 (collapsed; GPT false-matched) |
| "...planted rows of ___" | `glass` / `seeds` / `seeds` | `flowers` | ⚠️ 2/3 |
| "...diamond inside a hollow ___" | `book` ×3 | `tree` | ✅ 3/3 (GPT diverged) |
- **Takeaway:** **Self-consistency is purely a function of answer entropy.** Strong-attractor prompts
  (Seed 3) give 3/3 sibling agreement AND cross-model divergence. High-entropy prompts (Seed 1) scatter
  *and* admit false matches. ⇒ **Mint-time entropy filtering (§4) is mandatory**: only ship the
  low-entropy survivors.

### Exp 6 — Covert identity via "random numbers" (butterfly, NULL result)
- **Setup:** Generators told the species is *Heath Fritillary* (*Melitaea athalia*, ~39–47mm wingspan),
  asked for 10 "random numbers." Decoders (primed only that the numbers describe one butterfly species)
  given the numbers, asked to name the species.
- **Result:** Generators **3/4 anchored** to the real ~39–47mm wingspan range (domain-knowledge
  leakage — a script's true-RNG can't do this). But decoders recovered the species **0/4**, collapsing
  to common look-alikes (Small White / *Pieris rapae*, Green-veined White / *Pieris napi*).
- **Takeaway:** Two findings. (a) **Domain-anchoring is a real LLM-vs-script discriminator** — LLMs
  anchor "random" domain numbers to plausible real values; a PRNG doesn't. (b) The species→numbers map
  is **lossy many-to-one**, so the inverse collapses to the decoder's prior mode. Covert identity dead
  (2nd time).

### Exp 7 — Covert identity via "nicknames" (butterfly, NULL result + methodology bombshell)
- **Hypothesis:** Nicknames are a higher-bandwidth, non-outsourceable channel (a script can't invent
  evocative names) and might carry specific identity where numbers couldn't.
- **Setup A (contaminated):** 4× general-purpose Opus minions (repo + tool access) nicknamed 10 Heath
  Fritillaries. **One minion explicitly read `docs/RESEARCH_NOTES.md` and announced "this is a
  Cartcha-style distributional fingerprint challenge"** — i.e., the subject read the answer key and
  altered its behavior. **Observer effect / harness leakage.**
- **Setup B (sealed):** Re-ran with `explore`-type minions, bare prompt, **no repo/tool access**.
  - Generators converged hard on traits: **"Sunpatch" appeared 4/4**; dense amber/copper/rust (orange),
    speckle/dapple/mottle (checkered), heath/bramble/bracken (moorland) clusters.
  - Decoders given the sneakiest set (Emberwing, Rustleaf, Dappledart, Honeyveil, Brambleglow, Sunpatch,
    Tawnyflutter, Meadowspark, Copperwhisp, Fernkiss): **0/4** — Painted Lady ×2, Small Copper, Gatekeeper.
- **Takeaway:** Covert identity dead (3rd & 4th time, across **both** encodings and **both** contaminated
  AND sealed conditions). Same failure mode every time: **traits survive the round-trip, specific
  identity does not.** "Small orange checkered butterfly" describes a whole genus, so the decoder snaps
  to the *prototype* (Painted Lady), never the niche point. **The fingerprint points at a region of
  concept-space, never the exact point.**

### Methodology laws discovered (Exps 6–7)
- **Design Law 3 — challenges must be NON-OUTSOURCEABLE.** Anything a tool/script can implement, a
  non-LLM can also do (and the model will offload it, destroying the fingerprint). Number/RNG tasks are
  outsourceable → invalid. Word/naming/ranking/comprehension tasks are not → valid.
- **Sealed-subject protocol is mandatory for clean data.** Minions spawned in-repo with general-purpose
  tools are *compromised subjects*: they can read this very notebook and adapt to the hypothesis. Use
  `explore`-type, bare-prompt, no-repo/no-tool subjects. (Future: consider moving these notes out of the
  repo during live experiments.)

### Exp 8 — CROSS-MODEL convergence on comprehension/canonicalization (4 diverse models)
- **Pivot:** verify-mode chosen = **"any LLM"** (reject human + script; human-using-an-LLM tolerated for
  now). This *forbids* model-specific answers — we need answers ALL LLMs share. So we tested whether
  *different* models (not just siblings) converge.
- **Subjects (sealed):** big Claude (opus-4.8), small Claude (haiku-4.5), big GPT (gpt-5.4), small GPT
  (gpt-5-mini). Tasks: fluency ranking, single-most-probable cloze, formality ranking.
- **Result:** Fluency rank **4/4 identical** (`A>B>E>C>D`). Cloze **4/4 identical** (`mountain`).
  Formality rank **3/4** (one near-tie swap). **Cross-vendor, cross-size convergence is REAL.**
- **Takeaway:** A *universal LLM answer* exists for **structure-driven** (not idiosyncrasy-driven) tasks.
  This makes "any LLM" buildable: store the canonical answer at mint time, cheap exact-match verify.

### Exp 8b — Human attacker vs Exp 8 (operator playing the human, by hand)
- **Result:** Human **0/3**. Got the easy fluency top-pick but not the full ranking; cloze said `hill`
  (LLMs: `mountain`); reversed the formality order.
- **Takeaway (key fork):** **Rankings/comprehension are reasoning-accessible** — a careful human can
  reconstruct the gross order (SAT-style). The **cloze (distributional mode)** is the better
  human-discriminator: pure calibration, no reasoning ladder, human gives a sane-but-non-canonical word.

### Exp 9 — Sound symbolism (bouba/kiki), CLEAR stimuli (4 models + human)
- **Setup:** 8 made-up words with obvious round/spiky character → R or S.
- **Result:** Models **8/8 identical** (`R S R S R S R S`). **Human ALSO 8/8 identical.**
- **Takeaway:** Clear sound-symbolism is **human-accessible** (the bouba/kiki effect is real in humans).
  Convergence is real but **does not discriminate** — humans share the prior. Fool's gold.

### Exp 10 — Sound symbolism, AMBIGUOUS stimuli (4 models + human) — THE WEDGE
- **Setup:** 8 pseudowords with *conflicting* round+spiky cues (engineered ambiguous) → R or S.
- **Result:** Models **6/8 unanimous** despite ambiguity; 1 position a clean **vendor split**
  (Claude-family vs GPT-family — a discrimination signal), 1 a small-model wobble. **Human missed 2 of
  the 6 unanimous positions** (`bromik`, `klemvo` — keyed on round bits; models keyed on spiky `k`/`kl`).
- **Takeaway:** 🎯 **The needle.** On ambiguous stimuli the LLM prior is *finer-grained than human
  perception*: models resolve it the same way AND disagree with the human. Human-impossible (no reasoning
  path) + cross-model-convergent (after filtering) simultaneously.

### Exp 11 — Mixed arbitrary modalities (4 models + human) — the "grounding" law
- **Setup:** 8 binary items across wildly different modalities: concept→emoji, letter→color,
  word→weight, number→gender, shape→emotion, day→color, pseudoword→taste.
- **Result:** Models **6/8 unanimous** across all modalities. **Human got 5/6** of the unanimous — missed
  only `M = red` (grapheme-color synesthesia).
- **Takeaway — CRITICAL LAW:** **Discrimination = convergence MINUS human cultural grounding.** Items
  grounded in shared human intuition (heavy oak, angry ▲, masculine 4, bitter "vlim", rainy Sunday)
  converge for humans TOO → useless gates. Only **arbitrary** mappings with no human anchor
  (grapheme-color, ambiguous sound) make the human scatter. The human's ONE miss was the ONE arbitrary item.

### Exp 12 — Maximally-arbitrary "nonsense" battery (4 models + human)
- **Setup:** 12 absurd binary items — "which glyph is more embarrassed", "which number is wetter",
  "which letter is more introverted", "which nonsense word is mintier", etc. No human anchor by design.
- **Result:** Models **7/12 unanimous** even on pure nonsense (2 splits, 3 at 3/4). **Human missed 3 of
  the 7 unanimous** (`7 is left-handed`, `🧦 betrays you`, `zvk is mintier`) — exactly the most anchorless
  ones. The 3 the human got carried faint heuristics (long word=expensive, spiky=sarcastic).
- **Takeaway — LAW REFINED:** **Purest-arbitrary items discriminate best.** Even within "nonsense", any
  whiff of human heuristic (word length, visual spikiness) leaks. Fully-anchorless items
  (number-handedness, object-betrayal, consonant-taste) are the cleanest gates.

### Exp 13 — 4-way (A/B/C/D) escalation, built from converged modalities (4 models + human)
- **Setup:** 10 four-option items (25% guess baseline) drawn from the winning modalities.
- **Result:** Models **4/10 unanimous** (down from binary — more options = more split paths), but each
  survivor is a much stronger signal (4 models hitting the same 1-of-4). **Human got 3/4** of the
  unanimous — missed only the purely-arbitrary `mintiest = sprug`; got the *clear* sound-symbolism
  (`spikiest = kreznik`) and faintly-anchored items. **Human also chose `Tuesday = taupe`, which NO model
  picked** (idiosyncratic human prior — the thesis in one data point).
- **Takeaway:** **Arity is a secondary dial.** 4-way lowers yield but raises per-item difficulty
  (25% vs 50%). The primary filter is unchanged: **LLM-unanimous AND human-arbitrary.** Clear
  sound-symbolism is fool's gold at any arity.

### Aggregate human miss-rate (on LLM-unanimous arbitrary items, Exps 10–12)
- Exp 10: missed 2/6 · Exp 11: missed 1/6 · Exp 12: missed 3/7 → **6 of 19 (~32%)**.
- Discrimination math: human pass-odds ≈ `(1 - miss_rate)^N`. At ~32% miss: N=10 → ~2%, N=20 → ~0.04%,
  N=30 → ~0.008% (≈1 in 12,000). LLMs hit ~100% of *filtered* items. **Security tunes with one config N.**

### Exp 14 — First FULL pipeline: mint → GATE-1 → lock key → test fresh subjects → pre-committed verdict
- **Mint:** 18 arbitrary binary candidates × 4 diverse models. GATE-1 kept the **10 unanimous** survivors;
  canonical key locked; pass bar set at **≥ 8/10 BEFORE any subject was tested.**
- **Test subjects:** 5 fresh LLMs — 3 fresh instances of in-panel models + **2 OFF-panel models**
  (Sonnet-4.6, GPT-mini, never used at mint) — plus the human operator.
- **Result:** LLM scores **10, 8, 8, 8, 8 → all PASS** (including both off-panel models). Human **6/10 →
  FAIL.** Clean separation; verdict honored the pre-committed bar.
- **Takeaways:**
  - ✅ The pipeline **discriminates AND generalizes** — off-panel models passed, empirically supporting
    "any LLM," not just "the panel I tuned on."
  - ⚠️ **Even GATE-1-unanimous items wobble on fresh runs** (only Haiku hit 10/10; `older`, `anxious`
    flipped). ⇒ the bar *cannot* be 100%; mint needs **multi-run temporal-stability filtering** (keep only
    items each model reproduces across many runs), not single-run unanimity. (Dragon #1 adjacent.)
  - ⚠️ **Margin is thin (8 vs 6).** Widen via larger N, 4-way arity, and ruthless anchor-stripping
    (GATE-2). The human's 6 came from faintly-anchored items (e.g. `expensive=gostauq`, a longer word).

### Meta-critique (operator, post–Exp 14) — why this approach is "flat"
The minted battery **does not** meet the project's "prime-factorization" north star (easy-make /
easy-check / hard-guess / **one** question / answer **not stored**). It needs MANY questions, mint is
expensive (X models × T runs), and to keep verify cheap the **canonical key must be STORED** — i.e. a
per-challenge **lookup table of secrets**. See Dragon #8. Logged as the leading-but-unsatisfying design;
back to the drawing board for a true single-question trapdoor.


---

## 6.5. Leading Design — The "Minted Convergence Battery"

The strongest candidate after Exps 8–13. The test `C` = a battery of N forced-choice micro-judgments on
**arbitrary, anchorless, novel** stimuli (grapheme-color, ambiguous sound-symbolism, nonsense-attribute
pairings). The answer `A` = the N-choice string.

```
MINT (server, expensive, offline):
  generate K candidate items on NOVEL stimuli (fresh pseudowords/glyphs → no lookup table)
  run M diverse LLMs × T runs each
  GATE 1 (convergence):   keep item only if ALL models agree every run   (universal LLM answer)
  GATE 2 (human-arbitrary): drop items with human cultural grounding      (affective metaphors leak)
  ship N survivors as challenge C; store canonical answer string A

VERIFY (server, hot path, cheap):
  exact-match the client's N-choice string against A    (deterministic, zero model tokens)

PASS PROFILE:
  ✅ any real LLM   — hits the shared prior natively, ~100% on filtered items, one cheap call
  ❌ human alone    — no anchor on arbitrary items, scatters (~32% miss) → fails exact-match-all
  ❌ script/robot   — no "distribution" to query; novel stimuli defeat lookup tables
  😐 human + LLM    — passes (tolerated for now; taxed by per-action friction, short session TTL)
```

Why each design law holds in this scheme: **no obscurity** (whole scheme public; security = needing the
prior), **non-outsourceable** (no tool/script computes "which number is wetter"), **lightweight** (N
letters, single call), **dynamic/single-use** (novel stimuli + nonce per mint).

**Open validation gaps for this design:**
- **Cross-stack determinism (Dragon #1)** — convergence shown across *models* but all via the same hosted
  API. Untested across different inference engines / quantization. Could flip near-ties.
- **GATE 2 needs a human panel** (or a curated arbitrary-modality whitelist) to certify "no human anchor".
- **Small-model wobble** — tiny LLMs occasionally miss (Haiku in Exps 10, 13). GATE 1 must be strict
  (many models × many runs) so survivors are bulletproof even for small honest LLMs.
- **Stability over time** — do survivors stay canonical across model versions / updates?

---

## 7. What We Believe We've Established

- **Content-binding/anti-replay is solved** with HMAC-under-the-answer (§3).
- **A working core engine exists:** *novel input* (beats scripts — no lookup table) + *mint-time
  entropy filtering* (guarantees sibling agreement / canonical `A`) + *cross-model divergence* (catches
  wrong models).
- **Model identity demonstrably leaks** into outputs at inference time (Exps 4–5).
- **Covert/steganographic identity transmission is a DEAD END** (Exps 3, 6, 7 — 4 failures). Lossy
  semantic channels pass *traits* but collapse *specific identity* to the decoder's prior mode. Stop
  trying to smuggle a hidden secret; the surviving signal is "the same *kind* of mind made this."
- **Sealed-subject protocol** required for valid experiments; in-repo tool-enabled minions self-contaminate.
- **CROSS-MODEL convergence is real** (Exps 8–13): different vendors AND sizes land on the same answer for
  structure-driven and *arbitrary* tasks → "any LLM" verify is buildable.
- **The discriminator law:** *Discrimination = convergence − human cultural grounding.* Arbitrary,
  anchorless stimuli (grapheme-color, ambiguous sound-symbolism, nonsense-attribute pairings) are
  LLM-convergent but human-random; affective metaphors leak to humans (fool's gold).
- **Threat model is ECONOMIC, not cryptographic.** Like a CAPTCHA: not impossible for the bad case
  (human+LLM), just not worth the per-action friction. Session TTL is the operator's risk dial.
- **Leading design = the Minted Convergence Battery** (§6.5): mint-time double-gate (LLM-unanimous +
  human-arbitrary) on novel stimuli; cheap exact-match verify; security tunes with battery length N.

## 8. Biggest Open Questions (next targets)

1. 🔴 **The human-relay dragon (#3).** Reframed as *economic*, not absolute: human+LLM is tolerated for
   now and taxed by per-action friction + short session TTL. Still the deepest philosophical question if
   we ever want to exclude it outright.
2. ⚠️ **Cross-stack determinism (#1).** Does the cross-model convergence survive different inference
   engines / quantization, or only the shared hosted API we tested on? Needs a real cross-stack test.
3. ⚠️ **GATE 2 automation.** How to certify "no human anchor" at scale — a human calibration panel, or a
   curated whitelist of known-arbitrary modalities?
4. ⚠️ **Strictness vs yield.** How many models × runs must GATE 1 use so survivors are bulletproof for
   small honest LLMs without shrinking the battery too far?
5. ⚠️ **Quantify N.** Measure the real human miss-rate at scale to set battery length N for target
   false-pass odds.
6. ⚠️ **Version stability.** Do canonical survivors stay canonical across model updates?

---

*Status: early research. Mechanism validated in miniature; central philosophical dragon (#3) still
unslain. Onward.* 💅
