// COBRA ENGINE — entry point / build drill.
// The default answer is NO TRADE. Starting the engine does not start trading;
// it proves the skeleton loads, reports the true posture, then exits.
// On a fresh clone (no tape has ever run) the posture is COILED.
import { loadConfig } from './lib/config.js';
import { getEngineState } from './state/machine.js';

const config = loadConfig();
const state = getEngineState();

if (state.state === 'COILED') {
  console.log('COBRA COILED — NO TRADE');
} else if (state.state === 'STALKING') {
  console.log(`COBRA STALKING — ARMED, NO STRIKE (${Object.keys(state.stalking ?? {}).join(', ')})`);
} else {
  console.log(`COBRA ${state.state} — STANDING DOWN (${state.retreatCauses.map((c) => c.key).join(', ')})`);
}
console.log(
  `venue=${config.venue} universe=${config.universe.join(',')} ` +
    `locks=+${config.locks.selectivePct}/+${config.locks.protectPct}/+${config.locks.hardPct} ` +
    `state=${state.state}`
);
process.exit(0);
