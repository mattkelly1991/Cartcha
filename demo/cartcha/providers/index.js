/**
 * Minter provider selector.
 *
 * Chooses a key-source based on CARTCHA_MINTER:
 *   - "static" (default): the shipped, convergence-validated battery.
 *   - "llm": generate keys on the fly via an OpenAI-compatible endpoint (see ./llm.js).
 *
 * On any failure the LLM path falls back to static so the demo never hard-breaks.
 * Call initMinter(core) once at startup; it loads the pool into the core engine.
 */
'use strict';

const staticMinter = require('./static');
const llmMinter = require('./llm');

function selectMinter() {
  const choice = (process.env.CARTCHA_MINTER || 'static').toLowerCase();
  if (choice === 'llm') return llmMinter;
  return staticMinter;
}

/**
 * @param {object} core - the cartcha core module (needs setKeyPool)
 * @returns {Promise<{minter:string, count:number}>}
 */
async function initMinter(core) {
  const minter = selectMinter();
  try {
    const keys = await minter.generateKeys();
    core.setKeyPool(keys);
    return { minter: minter.name, count: keys.length };
  } catch (err) {
    if (minter.name !== 'static') {
      console.warn(`[cartcha] minter "${minter.name}" failed (${err.message}); falling back to static battery.`);
      const keys = await staticMinter.generateKeys();
      core.setKeyPool(keys);
      return { minter: 'static (fallback)', count: keys.length };
    }
    throw err;
  }
}

module.exports = { initMinter, selectMinter, staticMinter, llmMinter };
