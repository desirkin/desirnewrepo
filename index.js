// COBRA ENGINE — entry point / build drill.
// The default answer is NO TRADE. Starting the engine does not start trading;
// it proves the skeleton loads, then coils.
import { loadConfig } from './lib/config.js';
import { getEngineState } from './state/machine.js';

const config = loadConfig();
const state = getEngineState(config);

console.log(`COBRA COILED — NO TRADE`);
console.log(
  `venue=${config.venue} universe=${config.universe.join(',')} ` +
    `locks=+${config.locks.selectivePct}/+${config.locks.protectPct}/+${config.locks.hardPct} ` +
    `state=${state.state}`
);
process.exit(0);
