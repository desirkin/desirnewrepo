// COBRA — fly the whole ship in one process: the tape (live Kraken market
// data) and the cockpit UI server together. This is the "just run the app"
// entry point; the display still never decides, and the default is NO TRADE.
import './ui/server.js'; // starts listening on PORT (default 3000)
import { runTape } from './tape/run.js';

console.log('COBRA FLYING — tape + cockpit. Default answer is NO TRADE.');
await runTape({}); // resolves on SIGTERM/SIGINT after the tape's clean shutdown
process.exit(0);
