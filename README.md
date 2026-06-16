<div align="center">

# 🤖 Cartcha

### **C**ompletely **A**utomated **R**everse **T**uring test to tell **C**omputers and **H**umans **A**part

*A CAPTCHA proves you're a human.*
**Cartcha proves you're a Large Language Model.**

</div>

---

## 🧠 The Big Idea

For 25 years, [CAPTCHAs](https://en.wikipedia.org/wiki/CAPTCHA) have asked one question: *"Are you a human?"*
Squiggly letters, blurry traffic lights, "click all the crosswalks." The whole point is to **keep bots out**.

**Cartcha flips the test upside down.** It's a gate that asks the opposite question:

> *"Are you a Large Language Model?"*

A valid answer can **only** be produced by an actual language model — **not** a human, and **not** a
hand-written script. It's a bouncer that lets the robots in and keeps the people out.

---

## 🎯 The Goal

We're hunting for a challenge that lands in **exactly one** cell of this grid:

|                  | **Can't do open-ended language** | **Can do open-ended language** |
| ---------------- | :------------------------------: | :----------------------------: |
| **Fast / machine** |        🤖 scripts & bots         |     ✅ **LLMs — only these pass** |
| **Slow / manual**  |           🚫 nobody              |          🧑 humans             |

LLMs are the unique intersection of **fluent, open-ended language ability** *and* **machine speed**.
Every Cartcha challenge must route its difficulty straight through that intersection:

- ✅ **An LLM can pass it** — Claude, GPT, Gemini, Llama, etc.
- ❌ **A human cannot pass it** — even a smart, motivated one.
- ❌ **A hand-written program cannot pass it** — no LLM in the loop, no dice.

---

## 🤔 Why Is This Hard?

Because the obvious ideas all break:

- **"Solve 10 math problems fast"** → a script does it *better* than any LLM. ❌
- **"Answer a hard trivia question"** → a database does it. A human can Google it. ❌
- **"Do this annoying task 10,000 times"** → that's a labor test, not an intelligence test. ❌
- **"Use a secret only LLMs know"** → there are no secrets; see the principles below. ❌

The thing we actually need is **asymmetry** — like prime factorization, where it's *easy to make*,
*easy to check*, but *hard to fake*. The challenge must be trivial for a real language model and
effectively impossible for everything else.

---

## 📜 Design Principles

1. **🔓 No security through obscurity.** *([Kerckhoffs's Principle](https://en.wikipedia.org/wiki/Kerckhoffs%27s_principle))*
   The entire scheme — challenge, verification, code — is **public** (it lives on GitHub). Security comes
   *only* from the challenge genuinely requiring a language model. If publishing it breaks it, it was never secure.

2. **⚖️ Asymmetry (the "factoring" ideal).** Hard to produce, trivial to verify. The expensive work happens
   once, up front; checking an answer should be cheap.

3. **⏱️ No timers.** Difficulty must be *intrinsic*, not *temporal*. We don't beat humans with a stopwatch —
   we beat them with a question they fundamentally cannot answer.

4. **🎲 Dynamic & single-use.** Every challenge is freshly generated and never repeats. Knowing one answer
   never grants future access.

5. **🪶 Lightweight.** A real LLM should pass in **one cheap call**. The hard part is *comprehension*, not *labor*.

---

## 🚪 How It Works (the access-gate model)

Cartcha is an **API gate**, not a web form (a UI just invites a human back into the loop):

```text
1. Client  ──►  API :  "let me in"
2. API     ──►  Client :  challenge  (fresh, single-use, short-lived)
3. Client  ──►  API :  answer
4. API verifies  ──►  session token  ✅  (valid for a configurable duration)
```

How long a pass stays valid is the operator's dial: short = tight security, long = convenient.

---

## ▶️ Try the Demo

There's a working demo in [`demo/`](demo/) — a reCAPTCHA-style widget whose toggle reads
**"I am not a human."** Click it, get a challenge (rank sets of nonsense tokens by a property),
and watch an AI breeze through while a human guess gets bounced.

```bash
cd demo
npm install
npm start
# open http://localhost:3000
```

- **🤖 Simulate AI** → passes → gated *Access granted* page.
- **🧍 Try as Human** → random guess → denied (Kendall-τ below threshold).
- **Agent path** → `window.cartcha.challenge` + `window.cartcha.submit(answers)`.

The widget (`demo/public/cartcha.js`) and verifier (`demo/cartcha/`) are the shippable parts; the
pages are scaffolding. See [`demo/README.md`](demo/README.md) for details, security model, and how
to plug in an LLM minter.

---

## 🔬 The Research

Cartcha is **early-stage R&D**, and we're figuring it out the honest way: **by running experiments**, not
by guessing. We spin up multiple LLMs (across vendors *and* sizes) as test subjects, form a hypothesis,
and see what actually holds up.

**What we've found so far:**

- 🧲 **LLMs share a hidden "prior."** Ask different models — Claude, GPT, big, small — to judge something with
  *no right answer* ("which nonsense word is *mintier*?", "is the letter **M** red or blue?") and they
  **converge on the same answer**, across vendors and sizes.
- 🙅 **Humans don't share it.** On those same arbitrary, anchorless questions, a human is just guessing.
- 📐 **The discriminator law:** *Discrimination = convergence − human grounding.* The magic only works on
  questions a human has **no cultural anchor** for — that's the gap Cartcha exploits.
- 💀 **Dead ends matter too.** Smuggling a hidden secret through LLM outputs? Failed 4 times. Knowing what
  *doesn't* work is half the science.

The current leading design — the **"Minted Convergence Battery"** — and every experiment (the wins *and*
the faceplants) live in:

### 📓 [`docs/RESEARCH_NOTES.md`](docs/RESEARCH_NOTES.md)

That's the real lab notebook. Start there if you want the full story.

---

## 🐉 Open Problems ("Dragons")

This isn't solved yet — and we're honest about it. The big ones still breathing fire:

- **🔥 The human-relay dragon.** What stops a human from just *asking* an LLM and pasting the answer? (Current
  stance: treat it as an *economic* problem — make it annoying and not worth the effort, like a real CAPTCHA.)
- **🔥 Cross-stack determinism.** Does model agreement survive different hardware, inference engines, and quantization?
- **🔥 The flatness problem.** Today's design needs *many* small questions. The dream is **one** question that's
  high-entropy, LLM-only, and verifiable with a single hash compare. Still hunting for it.

---

## 📌 Status

> 🚧 **Early research.** The core mechanism works in miniature — LLMs pass, humans fail — but the elegant,
> single-question "prime-factorization" version is still on the drawing board. Onward. 💅

---

<div align="center">

*Cartcha — because someday the robots will need to prove they're robots.* 🤖

</div>