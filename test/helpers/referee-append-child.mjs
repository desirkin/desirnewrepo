// RESEARCH REFEREE test helper (child process): two of these contend for the same registry file from the SAME stored
// head. Each builds the identical one-record registry, signals readiness, waits for the parent's barrier file, then
// attempts the append and prints exactly one line: APPENDED, or the refusal it received. Deterministic synchronization
// (ready files + a barrier file) rather than a sleep, so the race is actually entered by both processes.
import { writeFileSync, existsSync } from 'node:fs';
import { createRegistry } from '../../research/referee/registry.js';
import { appendRegistryFile } from '../../research/referee/store.js';
import { registryWith, manifest } from './referee.js';

// Discovered by the default test runner as well as spawned by the race test: with no arguments this file is a no-op
// (the repo convention for child helpers), so it never reports a failure of its own.
const [file, barrier, tag] = process.argv.slice(2);
if (file && barrier && tag) {
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const next = registryWith([manifest({ name: 'w-a' })]).registry;
  writeFileSync(`${file}.ready-${tag}`, tag);
  while (!existsSync(barrier)) nap(2);
  try {
    const r = appendRegistryFile(file, createRegistry(), next);
    process.stdout.write(`APPENDED ${r.appended} ${tag}\n`);
  } catch (e) {
    process.stdout.write(`${e.researchMessage ?? e.message} ${tag}\n`);
  }
}
