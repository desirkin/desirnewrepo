// RESEARCH REFEREE test helper (child process): performs one registry append and is TERMINATED at a named phase, so
// the parent can inspect exactly what an interrupted writer leaves behind. The phase is reached deterministically by
// killing inside the data-write seam, never by timing. With no arguments this file is a no-op (the repo convention for
// child helpers discovered by the default test runner).
import { writeSync as fsWriteSync, fsyncSync as fsFsyncSync, writeFileSync } from 'node:fs';
import { createRegistry } from '../../research/referee/registry.js';
import { appendRegistryFile } from '../../research/referee/store.js';
import { registryWith, manifest, condition, feature } from './referee.js';

const [file, phase, ready] = process.argv.slice(2);
if (file && phase) {
  const die = () => { process.kill(process.pid, 'SIGKILL'); };
  const a = manifest({ name: 'kill-a' });
  const b = manifest({ name: 'kill-b', familyTag: 'KILL_OTHER', features: [feature('OTHER')], signal: { feature: 'OTHER', condition: condition('GT', 0) } });
  const next = registryWith([a, b]).registry; // a two-record tail, so "between records" is a real phase
  let calls = 0;
  const io = {
    writeSync(fd, buf, off, len) {
      calls += 1;
      if (phase === 'after-marker') die();                       // the marker is durable; not one data byte is written
      if (phase === 'between-records' && calls === 2) die();      // record one is complete and terminated
      return fsWriteSync(fd, buf, off, len);
    },
    fsyncSync(fd) { if (phase === 'after-all-writes') die(); return fsFsyncSync(fd); },
  };
  if (ready) writeFileSync(ready, phase);
  try { const r = appendRegistryFile(file, createRegistry(), next, { io }); process.stdout.write(`APPENDED ${r.appended}\n`); }
  catch (e) { process.stdout.write(`${e.researchMessage ?? e.message}\n`); }
}
