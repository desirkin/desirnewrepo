import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cached = null;

export function repoRoot() {
  return ROOT;
}

export function loadConfig() {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(path.join(ROOT, 'cobra.config.json'), 'utf8'));
  return cached;
}

export function dataDir(config = loadConfig()) {
  if (process.env.COBRA_DATA_DIR) return path.resolve(process.env.COBRA_DATA_DIR);
  return path.resolve(ROOT, config.tape.dataDir);
}

// Kraken v2 symbol for a universe coin, e.g. BTC -> "BTC/USD".
export function venueSymbol(coin, config = loadConfig()) {
  return `${coin}/${config.quote}`;
}

export function coinFromSymbol(symbol) {
  return symbol.split('/')[0];
}
