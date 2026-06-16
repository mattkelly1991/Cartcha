/**
 * Cartcha widget — the shippable client.
 *
 * Renders a reCAPTCHA-style "I am not a human" toggle. On activation it fetches a
 * challenge (sets of nonsense tokens to rank by a property), lets an LLM answer, submits,
 * and resolves to pass/fail. Humans can't reliably solve it; an LLM can.
 *
 * Integration for an AI agent driving a browser:
 *   const c = await window.cartcha.start();        // -> { challengeId, items, instructions }
 *   // rank each item's tokens least -> most of item.prop
 *   await window.cartcha.submit({ [itemId]: [orderedTokens...] });
 */
(function () {
  'use strict';

  const API = {
    challenge: '/api/challenge',
    verify: '/api/verify',
    demoSolve: '/api/demo-solve',
  };

  const state = {
    el: null,
    opts: {},
    challenge: null,
    busy: false,
  };

  function h(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function setCheck(cls) {
    const c = state.el.querySelector('.cartcha-check');
    c.className = 'cartcha-check' + (cls ? ' ' + cls : '');
  }

  function status(msg, kind) {
    const s = state.el.querySelector('.cartcha-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'cartcha-status' + (kind ? ' ' + kind : '');
  }

  function panel(open) {
    const p = state.el.querySelector('.cartcha-panel');
    p.classList.toggle('open', !!open);
  }

  function renderBox() {
    state.el.classList.add('cartcha');
    state.el.innerHTML = '';

    const box = h('div', 'cartcha-box');
    const check = h('div', 'cartcha-check');
    const label = h('div', 'cartcha-label', 'I am not a human');
    const brand = h(
      'div',
      'cartcha-brand',
      '<span class="cartcha-mark">\uD83E\uDD16</span><span class="cartcha-logo">cartcha</span>Privacy &middot; Terms'
    );
    box.append(check, label, brand);

    const p = h('div', 'cartcha-panel');
    p.appendChild(h('div', 'cartcha-panel-inner'));

    state.el.append(box, p);

    check.addEventListener('click', onActivate);
    label.addEventListener('click', onActivate);
  }

  function renderChallenge(challenge) {
    const inner = state.el.querySelector('.cartcha-panel-inner');
    inner.innerHTML = '';
    inner.appendChild(h('h4', null, 'Prove you are an AI'));
    inner.appendChild(
      h('p', 'cartcha-hint', 'Order each set of tokens from LEAST to MOST of the named property.')
    );

    challenge.items.forEach((it) => {
      const item = h('div', 'cartcha-item');
      item.appendChild(h('div', 'cartcha-prop', it.prop));
      const chips = h('div', 'cartcha-chips');
      it.tokens.forEach((t) => chips.appendChild(h('span', 'cartcha-chip', t)));
      item.appendChild(chips);
      inner.appendChild(item);
    });

    const actions = h('div', 'cartcha-actions');
    const ai = h('button', 'cartcha-btn primary', '\uD83E\uDD16 Simulate AI');
    const human = h('button', 'cartcha-btn ghost', '\uD83E\uDDCD Try as Human');
    ai.addEventListener('click', simulateAI);
    human.addEventListener('click', tryAsHuman);
    actions.append(ai, human);
    inner.appendChild(actions);

    inner.appendChild(h('div', 'cartcha-status'));
    inner.appendChild(
      h(
        'div',
        'cartcha-agent',
        'Agent? Read <code>window.cartcha.challenge</code> and call ' +
          '<code>window.cartcha.submit(answers)</code>.'
      )
    );
    panel(true);
  }

  async function onActivate() {
    if (state.busy || (state.challenge && !state.failed)) return;
    return start();
  }

  /** Fetch a fresh challenge and render it. Returns the challenge (for agents). */
  async function start() {
    state.busy = true;
    state.failed = false;
    setCheck('loading');
    status('');
    try {
      const res = await fetch(API.challenge, { method: 'POST' });
      const challenge = await res.json();
      state.challenge = challenge;
      window.cartcha.challenge = challenge;
      renderChallenge(challenge);
      setCheck('');
      return challenge;
    } catch (e) {
      setCheck('fail');
      status('Could not load challenge.', 'err');
      throw e;
    } finally {
      state.busy = false;
    }
  }

  /** Submit answers { itemId: [orderedTokens] } for the active challenge. */
  async function submit(answers) {
    if (!state.challenge) throw new Error('no active challenge');
    setCheck('loading');
    status('Verifying\u2026');
    const res = await fetch(API.verify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: state.challenge.challengeId, answers }),
    });
    const result = await res.json();
    handleResult(result);
    return result;
  }

  function handleResult(result) {
    if (result.pass) {
      state.failed = false;
      setCheck('pass');
      status(`Verified \u2713  (\u03c4=${result.score} \u2265 ${result.threshold})`, 'ok');
      panel(false);
      const token = result.token;
      setTimeout(() => state.opts.onPass(token), 700);
    } else {
      state.failed = true;
      setCheck('fail');
      const why = result.error
        ? result.error.replace(/_/g, ' ')
        : `\u03c4=${result.score} < ${result.threshold}`;
      status(`Failed: ${why}. Click to retry.`, 'err');
      state.opts.onFail(result);
    }
  }

  async function simulateAI() {
    try {
      const res = await fetch(API.demoSolve, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: state.challenge.challengeId }),
      });
      const { answers, error } = await res.json();
      if (error) {
        status('Challenge expired. Click to retry.', 'err');
        return;
      }
      await submit(answers);
    } catch (e) {
      status('Simulation failed.', 'err');
    }
  }

  function tryAsHuman() {
    // A guessing human = a random permutation per item.
    const answers = {};
    state.challenge.items.forEach((it) => {
      answers[it.id] = it.tokens
        .map((t) => [Math.random(), t])
        .sort((a, b) => a[0] - b[0])
        .map((p) => p[1]);
    });
    submit(answers);
  }

  function render(selector, opts) {
    state.el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!state.el) throw new Error('cartcha: container not found');
    state.opts = Object.assign(
      {
        onPass: (token) => {
          location.href = 'success.html?token=' + encodeURIComponent(token || '');
        },
        onFail: () => {},
      },
      opts || {}
    );
    renderBox();
  }

  window.cartcha = { render, start, submit, get challengeData() { return state.challenge; } };
})();
