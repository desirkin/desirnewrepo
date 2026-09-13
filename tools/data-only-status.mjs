import { readDataOnlyRuntimeStatus } from '../lib/data-only-status.js';

try {
  const status = readDataOnlyRuntimeStatus();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (!status.effectiveRunning) process.exitCode = 1;
} catch (error) {
  console.error(`DATA_ONLY_STATUS_UNAVAILABLE: ${error.message}`);
  process.exitCode = 1;
}
