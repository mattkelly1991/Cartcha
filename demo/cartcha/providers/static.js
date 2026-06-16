/**
 * Static minter (default).
 *
 * Returns the pre-minted, convergence-validated golden battery shipped in
 * ../battery.json. These keys were derived offline from Exp 16a (4 model families x
 * 3 runs, Borda consensus) and deploy-validated in Exp 16b. No network, no API key.
 */
'use strict';

const fs = require('fs');
const path = require('path');

async function generateKeys() {
  const battery = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'battery.json'), 'utf8')
  );
  return battery.keys;
}

module.exports = { name: 'static', generateKeys };
