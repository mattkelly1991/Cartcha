/**
 * CARTCHA widget — STATIC SHOWCASE build (GitHub Pages, no backend).
 *
 * Mints and verifies entirely in the browser so it can run on static hosting.
 * ⚠️  Because there's no server, the canonical answers live in this file — i.e. they
 * are peekable. That's fine for demonstrating the UX, but it is NOT a security boundary.
 * The real product (see /demo) keeps the answers server-side and verifies there.
 */
(function () {
  'use strict';

  // Golden keys (canonical = LEAST -> MOST of the property), from Exp 16a/16b.
  const BATTERY = [
    { id: 'ancient',   prop: 'ancient',   canonical: ['kra', 'snou', 'zziss', 'cloox', 'thrae', 'thraunk'] },
    { id: 'spicy',     prop: 'spicy',     canonical: ['pla', 'twou', 'flong', 'queemb', 'snaenk', 'fnooff'] },
    { id: 'magic',     prop: 'magical',   canonical: ['trut', 'braux', 'ykoang', 'wuxamb', 'wuxoop', 'throoss'] },
    { id: 'stupid',    prop: 'stupid',    canonical: ['oui', 'dret', 'vrau', 'glyaz', 'floald', 'glaush'] },
    { id: 'dangerous', prop: 'dangerous', canonical: ['ouou', 'blot', 'swirt', 'quoumb', 'zzeez', 'wuxoup'] },
    { id: 'heavy',     prop: 'heavy',     canonical: ['gvu', 'gvoz', 'quaust', 'drank', 'fnoust', 'drouss'] },
    { id: 'loud',      prop: 'loud',      canonical: ['ouip', 'blat', 'bryald', 'clank', 'kronk', 'zzauld'] },
    { id: 'royal',     prop: 'royal',     canonical: ['clip', 'spild', 'quuff', 'shooz', 'krauff', 'kraumb'] },
  ];
  const CONFIG = { itemsPerChallenge: 6, threshold: 0.4 };

  const state = { el: null, opts: {}, challenge: null, canonical: null, failed: false };

  // --- helpers -------------------------------------------------------------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function kendallTau(a, b) {
    const pos = new Map(a.map((t, i) => [t, i]));
    const q = b.map((t) => pos.get(t));
    let c = 0;
    let d = 0;
    for (let i = 0; i < q.length; i++) {
      for (let j = i + 1; j < q.length; j++) {
        if (q[i] < q[j]) c++;
        else if (q[i] > q[j]) d++;
      }
    }
    return c + d === 0 ? 0 : (c - d) / (c + d);
  }

  function h(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function setCheck(cls) {
    state.el.querySelector('.cartcha-check').className = 'cartcha-check' + (cls ? ' ' + cls : '');
  }
  function status(msg, kind) {
    const s = state.el.querySelector('.cartcha-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'cartcha-status' + (kind ? ' ' + kind : '');
  }
  function panel(open) {
    state.el.querySelector('.cartcha-panel').classList.toggle('open', !!open);
  }

  // --- local mint / verify -------------------------------------------------
  function mint() {
    const picked = shuffle(BATTERY).slice(0, CONFIG.itemsPerChallenge);
    const canonical = {};
    const items = picked.map((k) => {
      canonical[k.id] = k.canonical;
      return { id: k.id, prop: k.prop, tokens: shuffle(k.canonical) };
    });
    state.canonical = canonical;
    return { challengeId: 'local-' + Math.random().toString(16).slice(2), threshold: CONFIG.threshold, items };
  }

  function verifyLocal(answers) {
    const perItem = {};
    const taus = [];
    for (const [id, canonical] of Object.entries(state.canonical)) {
      const sub = answers[id];
      const set = new Set(canonical);
      const valid =
        Array.isArray(sub) && sub.length === canonical.length &&
        sub.every((t) => set.has(t)) && new Set(sub).size === canonical.length;
      const tau = valid ? kendallTau(canonical, sub) : -1;
      perItem[id] = { tau: Number(tau.toFixed(3)), valid };
      taus.push(tau);
    }
    const score = taus.reduce((s, t) => s + t, 0) / taus.length;
    const pass = score >= CONFIG.threshold;
    const result = { pass, score: Number(score.toFixed(3)), threshold: CONFIG.threshold, perItem };
    if (pass) {
      const token = Math.random().toString(16).slice(2) + Date.now().toString(16);
      sessionStorage.setItem('cartcha_pass', JSON.stringify({ token, exp: Date.now() + 10 * 60 * 1000 }));
      result.token = token;
    }
    return result;
  }

  // --- ui ------------------------------------------------------------------
  function renderBox() {
    state.el.classList.add('cartcha');
    state.el.innerHTML = '';
    const box = h('div', 'cartcha-box');
    const check = h('div', 'cartcha-check');
    const label = h('div', 'cartcha-label', 'I am not a human');
    const brand = h('div', 'cartcha-brand',
      '<span class="cartcha-mark">\uD83E\uDD16</span><span class="cartcha-logo">cartcha</span>Privacy &middot; Terms');
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
    inner.appendChild(h('p', 'cartcha-hint', 'Order each set of tokens from LEAST to MOST of the named property.'));
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
    inner.appendChild(h('div', 'cartcha-agent',
      'Agent? Read <code>window.cartcha.challenge</code> and call <code>window.cartcha.submit(answers)</code>.'));
    panel(true);
  }

  function onActivate() {
    if (state.challenge && !state.failed) return;
    start();
  }

  function start() {
    state.failed = false;
    setCheck('loading');
    status('');
    setTimeout(() => {
      const challenge = mint();
      state.challenge = challenge;
      window.cartcha.challenge = challenge;
      renderChallenge(challenge);
      setCheck('');
    }, 250); // tiny delay so the spinner reads
    return state.challenge;
  }

  function submit(answers) {
    if (!state.challenge) throw new Error('no active challenge');
    setCheck('loading');
    status('Verifying\u2026');
    const result = verifyLocal(answers);
    handleResult(result);
    return Promise.resolve(result);
  }

  function handleResult(result) {
    if (result.pass) {
      state.failed = false;
      setCheck('pass');
      status(`Verified \u2713  (\u03c4=${result.score} \u2265 ${result.threshold})`, 'ok');
      panel(false);
      setTimeout(() => state.opts.onPass(result.token), 700);
    } else {
      state.failed = true;
      setCheck('fail');
      status(`Failed: \u03c4=${result.score} < ${result.threshold}. Click to retry.`, 'err');
      state.opts.onFail(result);
    }
  }

  function simulateAI() {
    submit(state.canonical); // canonical ordering = a perfect-converging AI
  }

  function tryAsHuman() {
    const answers = {};
    state.challenge.items.forEach((it) => {
      answers[it.id] = it.tokens.map((t) => [Math.random(), t]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    });
    submit(answers);
  }

  function render(selector, opts) {
    state.el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!state.el) throw new Error('cartcha: container not found');
    state.opts = Object.assign({
      onPass: (token) => { location.href = 'success.html?token=' + encodeURIComponent(token || ''); },
      onFail: () => {},
    }, opts || {});
    renderBox();
  }

  window.cartcha = { render, start, submit, get challengeData() { return state.challenge; } };
})();
