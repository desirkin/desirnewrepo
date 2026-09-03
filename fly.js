// COBRA — fly the whole ship in one process: the tape (live Kraken market
// data) and the cockpit UI server together. This is the "just run the app"
// entry point; the display still never decides, and the default is NO TRADE.
import './ui/server.js'; // starts listening on PORT (default 3000)
import { runTape } from './tape/run.js';
import { startRumint } from './rumint/poller.js';
import { startGateway } from './gateway/collector.js';

console.log('COBRA FLYING — tape + cockpit. Default answer is NO TRADE.');
startRumint(); // no-ops (zero network) unless rumint is enabled
startGateway(); // no-ops (zero network) unless gateway is enabled — collector only
await runTape({}); // resolves on SIGTERM/SIGINT after the tape's clean shutdown
process.exit(0);
