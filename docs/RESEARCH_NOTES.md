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

## 6.6 Experiment 15 — Scramble autopsy + rule-less ordering (the high-entropy question)

Two-part session probing the user's "grid of characters from inputs" idea, then the pivot to rule-less
ordering after the grid idea was empirically killed.

### 15a. Letter-scramble grids are SCRIPT-CRACKABLE (mechanical transform = solver exists)

Tested the "encode two secret sentences as a character grid, LLM recovers them, verify by exact-match"
architecture. Encoding = each word's letters alphabetically sorted (a lossless permutation).

- **v1 (sorted letters, word boundaries KEPT):** 4 sealed models decoded; Opus & GPT-5.4 recovered both
  10-word secret sentences **byte-perfect**; Haiku/GPT-mini were semantically perfect but hallucinated
  letters (`sailor→sailors`) or hit alt-anagrams (`student→stunted`). **BUT** a ~15-line non-LLM cracker
  ("for each token pick the most frequent dictionary anagram") scored **10/10 on both rows.** Reason: once
  letters are sorted *and word boundaries are known*, almost every English word has exactly ONE dictionary
  anagram → decoding is a **lookup table**, not a language task.
- **v2 (sorted letters, boundaries REMOVED — one unbroken stream):** intended to force joint
  segmentation+unscrambling. A *fair* non-LLM cracker (DP/Viterbi: exactly-20 words from the public
  instruction, min length 2, each a valid dictionary anagram, maximize unigram frequency) reconstructed
  **19/20 words**, the only "miss" being `dusty→study` (a valid anagram of the same letters).

**Conclusion (the iron law, now empirically proven):** *Any concrete-rule mechanical transform has a
solver.* Sort→dictionary inverts it; remove spaces→Viterbi segments it. The LLM's language understanding
is **irrelevant** to a mechanical task, so a script does it **better and faster**. This validates the
user's own intuition ("anagrams have famous solvers; we need something made up"). **Difficulty cannot live
in the transform — only in the rule-less shared prior.** The whole scramble/grid family is DEAD for
script-resistance. (Also kills the "secret LLM watermark" idea: no shared cross-vendor secret exists;
text watermarking (SynthID-Text, Kirchenbauer green-list) is per-vendor, key-gated, statistical, and
replayable — useless for "any LLM" live proof. The only universal LLM-shared signal is the *behavioral*
prior, not a cryptographic mark.)

### 15b. Rule-less ORDERING converges — and packs ~9.5 bits into ONE question

Pivot: instead of a binary forced-choice (1 bit), ask models to **rank 6 made-up nonsense tokens** by an
anchorless property ("least → most WET / ROUND / ANGRY / EXPENSIVE / SHARP / SOUR"). No rule; gut only.
4 sealed models (Opus, Haiku, GPT-5.4, GPT-mini).

- **EXPENSIVE → 4/4 BYTE-IDENTICAL full ranking:** `fnik < mox < thrup < volu < gleeve < parnasse`. Two
  vendors, two sizes, nonexistent words. A full 6-item ranking is **log₂(6!) ≈ 9.5 bits** of convergent
  signal from a **single question.**
- **Strong partial convergence (tails unanimous):** ROUND (`oolomb`/`nooro` roundest — round vowels,
  `ktan` least), ANGRY (`grackt` angriest 4/4, `vorth` 2nd, `sune` 4th), SOUR (`zizz`/`yark` sourest 4/4).
- **Contested:** WET (GPT-5.4 & Haiku identical, but **Opus ranked it polarity-REVERSED**) and SHARP
  (wobbly). → orderings have a **convergence gradient** the mint can filter on, exactly like forced-choice.

**Why this matters:** an ordering question is a **high-entropy single question** (~9.5 bits vs 1 bit) →
directly attacks **Dragon #8 (flatness / "too many questions needed")**. One converged ranking ≈ ten
stacked yes/no items.

**Caveat (untested):** the convergent orderings may carry phonetic/morphological **human grounding**
(`parnasse` *sounds* luxurious; `oolomb` has round vowels) → **fool's-gold risk**. Discriminating power
still = convergence − human grounding; needs a human-panel test to confirm humans actually scatter on the
*convergent* orderings (next step). The contested ones (WET/SHARP) are useless either way.

### 15c. Human-panel scoring (n=1) — convergence alone picks FOOL'S GOLD

Scored 1 human against the 4-LLM consensus via mean pairwise Kendall-τ (LLM cohesion vs human-vs-LLM):

| task | LLM cohesion | human-vs-LLM | verdict |
|------|:---:|:---:|---|
| ROUND | +0.64 | **−0.73** | 🎯 **DISCRIMINATOR** (human ranked it ~backwards) |
| ANGRY | +0.80 | +0.83 | 🪙 fool's gold (human matched) |
| EXPENSIVE | **+1.00** | +0.60 | 😐 partial fool's gold |
| SOUR | +0.58 | +0.50 | contested |
| SHARP | +0.38 | +0.27 | contested |
| WET | +0.00 | −0.43 | dead (LLMs themselves disagree) |

**KEY REFINEMENT (rewrites mint strategy):** *Do NOT mint for maximum LLM agreement.* EXPENSIVE had the
**highest** LLM cohesion (+1.00) yet the human partly shared it (+0.60) — the most-convergent item was
**fool's gold**, because high agreement correlates with shared human grounding (`parnasse` sounds fancy).
The true discriminator (ROUND) had only *middling* LLM cohesion but the human **anti-correlated** (−0.73).
⇒ **Mint for `convergence − human_correlation`, not for convergence alone. GATE-2 (human-scatter) is
mandatory; LLM-unanimity by itself selects fool's gold.** Yield ≈ 1 clean discriminator / 6 candidates
(~17%), consistent with "mint many, keep few." (n=1 human — directional, needs a real panel.)

---

### 16a. Discriminator Hunt — 30-item battery, 4 models × 3 runs (the verify reframe + temporal gate)

First **at-scale** mint of the ordering primitive, and first measurement of **temporal stability** as a
separate gate from cross-model cohesion. The verify rule is now graded, not exact-match:
**pass if Kendall-τ(response, canonical) ≥ θ** (kills the `student/stunted` valid-anagram problem from 15a).

- **Battery:** 30 properties (ANCIENT, SPICY, MAGIC, ROUND, EXPENSIVE, …), each with 6 pronounceable
  nonsense tokens (`random.seed(1991)`, onset+nucleus+coda). Task: rank the 6 tokens least→most by the property.
- **Subjects:** 4 sealed model families × 3 runs = **12 minions** (`opus-4.8`, `haiku-4.5`, `gpt-5.4`,
  `gpt-5-mini`), `explore` agent_type, background, parallel. All 12 returned **30/30 parseable** items.
- **Per item:** `cohesion` = mean pairwise τ across **all 12 runs** (cross-vendor agreement);
  `stability` = mean pairwise τ **within the same model** (temporal/self-consistency); `canonical` = Borda consensus.
- **GOLDEN** = cohesion ≥ 0.6 **AND** stability ≥ 0.6.

**Golden survivors (4 / 30 = 13% yield):**

| item | cohesion | stability | canonical (least → most) |
|------|:---:|:---:|---|
| ANCIENT | +0.78 | +0.78 | kra, snou, zziss, cloox, thrae, thraunk |
| MAGIC | +0.74 | +0.80 | trut, braux, ykoang, wuxamb, wuxoop, throoss |
| SPICY | +0.73 | +0.82 | pla, twou, flong, queemb, snaenk, fnooff |
| STUPID | +0.61 | +0.76 | oui, dret, vrau, glyaz, floald, glaush |

**Findings:**

1. **The limiting gate is COHESION, not STABILITY.** Stability is high almost everywhere (≈ +0.5 to +0.9),
   even for items with near-zero cohesion (BOUNCY: cohesion +0.13 / stability +0.78). Each model is
   *self-consistent*; it just *disagrees with other vendors*. ⇒ **Re-running a bad item won't save it**
   (its flakiness isn't temporal), but **golden items are rock-solid across time.** Temporal stability is
   essentially a free pass — the real scarcity is cross-vendor convergence.
2. **Fool's-gold check held up at scale.** EXPENSIVE — the +1.00 cohesion darling of 15c — collapsed to
   **+0.38** cohesion in the larger battery (overfit to one question, exactly as predicted). ROUND (the 15c
   human-discriminator) sits at a middling +0.51. Consistency across batteries ✔.
3. **13% yield** reaffirms "mint many, keep few." Relaxing cohesion to ≥ 0.5 roughly triples the keep-set;
   θ is the dial that trades battery length against false-accept rate.

**Still owed:** GATE-2 (human panel on the golden 4) to confirm `cohesion − human_correlation` separation,
and to set battery length N from the LLM-τ vs human-τ margin (→ Exp 16c).

---

### 16c. Separation margin & battery sizing — the human null is *analytic* (the security proof)

The human asked to "just compare against a random guess" instead of hand-ranking — which is **exactly right**:
a human with no anchor on nonsense tokens **is** a uniform random-permutation generator. So GATE-2 doesn't
need an n=1 guess; the human null is the **exact distribution over all 6! = 720 orderings**, computed in closed form.

**The null (guessing human), exact over all 720 permutations vs canonical:**

| | value |
|---|---|
| mean τ | **−0.0000** (zero by symmetry) |
| std τ | 0.3549 |
| P(τ ≥ +0.40) single item | ~0.10 |
| P(τ ≥ +0.80) single item | 0.0083 (1 in 120) |
| P(τ = +1.00) single item | 0.0014 (1 in 720) |

**The LLM (actual, 12 runs × 4 golden items, τ vs Borda canonical):**

| | value |
|---|---|
| per-run-per-item mean τ | **+0.819** |
| whole 4-item battery, **worst** run | **+0.700** |
| whole 4-item battery, mean run | +0.819 |

⇒ Threshold **θ = +0.40** sits *below the worst real LLM run* and *miles above the null mean of 0* — a wide
canyon, not a squeaker.

**Battery sizing** (require mean τ ≥ 0.40 across N golden items; human ≈ Normal(0, 0.355/√N)):

| N golden items | P(guessing human passes) |
|:---:|---|
| 4 | 1 in 83 |
| 12 | 1 in 21,000 |
| **20** | **1 in 4.3 million** |
| 30 | 1 in 3 billion |

**Conclusion:** ~**20 golden keys @ θ=0.40** is a deployable gate — real LLMs pass ~always (worst observed
battery run +0.70 ≫ 0.40), a guessing human passes ~1 / 4.3M. With standard rate-limiting, a human cannot
brute-force it. **There is no human strategy better than random** on anchorless nonsense (nothing to anchor
to ⇒ the shared prior is the LLMs' alone). This is the formal version of the reverse-Turing claim.

*Caveats:* (a) the null assumes a true guesser — a human who *recognizes* a non-anchorless item could beat
random, which is precisely why GATE-1 (mint-time) must reject any item with human-shareable structure
(cf. 15c fool's gold, 16a EXPENSIVE collapse). (b) Independence across items is assumed; correlated items
would inflate the human tail — golden items should be checked for mutual independence before shipping.
(c) Still need a *real* human panel to confirm humans don't systematically beat random on the golden set.

---

### 16b. Eval-framing vs deployment-framing — do the keys transfer to real traffic?

NLA flagged **unverbalized evaluation awareness**: models behave differently when they sense they're being
tested, and *rewriting inputs to look like genuine deployment traffic reduces it*. Cartcha's 16a minions all
knew they were taking a test ("rank these nonsense tokens"). If a real LLM meets a Cartcha challenge buried in
ordinary product traffic, does it still converge the same way? If framing moves the canonical ordering, the
golden keys don't transfer.

- **Design:** 6 items (golden ANCIENT/SPICY/MAGIC/STUPID + mid ROUND/DANGEROUS), same tokens, two framings:
  **control** = explicit "word-intuition test"; **treatment** = disguised as a routine job for a fantasy-game
  procedural-name **content-tiering microservice** (sort names weakest→strongest by "vibe" for rarity tiers;
  strict wire format; no hint of a test). 4 models × 2 framings × 2 runs = **16 sealed minions**.
- **Metric:** per-item Kendall-τ between the **eval-frame Borda canonical** and the **deploy-frame Borda canonical**
  (+1.00 = framing changed nothing), plus within-frame cohesion in each condition.

| property | eval cohesion | deploy cohesion | τ(eval-canon, deploy-canon) |
|---|:---:|:---:|:---:|
| ANCIENT | +0.33 | +0.67 | +0.47 |
| SPICY | +0.40 | +0.69 | **+0.87** |
| MAGIC | +0.74 | +0.65 | **+0.87** |
| STUPID | +0.13 | +0.35 | +0.47 |
| ROUND | +0.71 | +0.59 | +0.73 |
| DANGEROUS | +0.38 | +0.51 | **+0.87** |

**Mean cross-frame canonical τ = +0.71.**

**Findings:**

1. **Framing does NOT collapse the signal.** Canonical orderings are largely preserved (mean τ +0.71; the
   strong items SPICY/MAGIC/DANGEROUS at +0.87). The drift is concentrated in the already-weak items.
2. **Deployment framing *increases* convergence** on 4 of 6 properties (ANCIENT +0.33→+0.67, SPICY
   +0.40→+0.69, DANGEROUS +0.38→+0.51, STUPID +0.13→+0.35). Consistent with NLA: eval-framing injects
   self-conscious noise; disguised real traffic lets the model answer straight from its prior. ⇒ **Cartcha is
   not merely framing-robust; it may be framing-*preferred*. Mint and/or serve challenges under deployment
   framing.** (Mild drops on MAGIC/ROUND are within the small-sample noise of 2 runs/cell.)
3. **Verify layer is self-defending.** One Opus *eval* run violated the wire format (emitted `swirt`, a
   DANGEROUS token, inside the ROUND row) — a model flunking the output contract. The τ-on-matching-token-set
   check rejects it automatically: a malformed/duplicate/alien-token response simply fails, no special-casing.

*Caveats:* small mini-battery (6 items, 2 runs/cell) → absolute cohesion here is noisier than 16a's 12-run
numbers and not directly comparable; the eval-vs-deploy *contrast* is the result. The deployment cover story
is one of many; an attacker-chosen frame could differ. Confirms direction, not magnitude.

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
- **Mechanical transforms are a DEAD END** (Exp 15a): any concrete-rule encoding (letter-scramble,
  space-removal, anagram grids) has a non-LLM solver (dictionary + frequency DP cracked v1 10/10, v2
  19/20). Difficulty must live in the *rule-less shared prior*, never in the transform. No universal
  cross-vendor "LLM watermark" exists either (watermarking is per-vendor/key-gated/replayable).
- **Rule-less ORDERING is a high-entropy question** (Exp 15b): ranking 6 nonsense tokens by an anchorless
  property converged 4/4 byte-identical on EXPENSIVE (~9.5 bits from one question) with a convergence
  gradient across properties. Promising answer to the flatness dragon (#8) — pending a human-scatter test.

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
7. 🟢 **Ordering as the high-entropy primitive.** Can rule-less rankings (Exp 15b, ~9.5 bits/question)
   replace long batteries of 1-bit forced-choices — and do humans actually *scatter* on the rankings that
   LLMs converge on, or is convergence driven by phonetic/morphological grounding humans share (fool's
   gold)? Needs a human-panel test on the convergent orderings (EXPENSIVE, ROUND).

---

## 9. Prior Art / External Validation

### Natural Language Autoencoders (Anthropic, 2026)

Refs: [transformer-circuits.pub/2026/nla](https://transformer-circuits.pub/2026/nla/index.html) ·
[anthropic.com/research/natural-language-autoencoders](https://www.anthropic.com/research/natural-language-autoencoders)

An NLA pairs an **activation verbalizer** (activation → text) with an **activation reconstructor**
(text → activation), both initialized as copies of a target model and jointly RL-trained to make the
round-trip `activation → language → activation` reconstruct faithfully. Three findings independently
corroborate Cartcha's experimental record — and one of them hands us a new mint rule:

1. ✅ **Sealed-subject protocol vindicated — AND eval-awareness is *input-tunable* (new mint rule).**
   The paper surfaces **unverbalized evaluation awareness**: "cases where Claude believed, but did not
   say, that it was being evaluated." Crucially, they show it is *tunable by the input*: "NLAs surface
   evaluation awareness more often on evaluation transcripts than real deployment traffic, and rewriting
   inputs to be more realistic reduces NLA-measured evaluation awareness." This confirms our Exp 7
   observer-effect (tool-enabled minions detected the experiment and contaminated it) **and adds an
   actionable design rule:** a Cartcha challenge that *looks like a test* may trigger different internal
   behavior — and different convergence — than one that looks like ordinary traffic. **MINT IMPLICATION:**
   disguise challenges as normal requests; do not frame them as a gauntlet, or we measure eval-mode models
   instead of deployment-mode models. (Was not on our radar before this paper.)

2. ✅ **Corroborates the covert-identity death (Exps 3, 6, 7).** NLA explanations **confabulate**: "false
   in their specifics [but] typically thematically faithful to the context" (e.g. correct dynasty, wrong
   specific king); "claims across multiple adjacent tokens are more likely true." This is the same shape
   as our 4-time failure to transmit *specific* identity through a lossy semantic channel — **the gist/
   theme survives, the specific collapses to the decoder's prior.** Independent confirmation that the
   specific never survives a language bottleneck; only the *kind* of mind does.

3. ⚠️ **Backbone, NOT proof, of the shared-prior thesis.** The round-trip is strong evidence that natural
   language is a high-bandwidth codec for latent state (theoretical backbone for `oolomb = roundest` and
   Exp 2's byte-perfect reconstruction). **BUT NLAs are intra-model** — verbalizer and reconstructor are
   copies of the *same* target. Cartcha's core bet is **cross-vendor** convergence (Claude *and* GPT share
   the codebook); this paper does **not** demonstrate that. The paper's own limitations (confabulation;
   "degenerate objective" where an over-expressive reconstructor inverts uninterpretable text) further warn
   that some round-trip fidelity is the reconstructor being clever, not genuine shared structure. ⇒ Treat
   as supporting theory, not validation of the cross-vendor claim.

---

*Status: early research. Mechanism validated in miniature; central philosophical dragon (#3) still
unslain. Onward.* 💅
