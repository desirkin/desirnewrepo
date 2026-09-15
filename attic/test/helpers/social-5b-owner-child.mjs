import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { baseFixture, datasetCandidate, work, cleanup, C, IO } from './social-5b-owner-support.mjs';

const mode = process.env.SERPENT_ACCEPTANCE_CHILD_MODE;
if (mode) {
  const ctl = globalThis.__serpentOwnerFs;
  assert.ok(ctl, 'the child must run with the isolated fs preload');
  let result;
  try {
    if (mode === 'close') {
      const base = await baseFixture(); // complete lawful positive BEFORE arming
      ctl.target = process.env.SERPENT_ACCEPTANCE_CLOSE_TARGET;
      assert.ok(['features.jsonl.part', 'coverage.json.part', 'dataset.manifest.json.part'].includes(ctl.target));
      ctl.closeFault = true; ctl.armed = true;
      const r = datasetCandidate(base);
      result = { injected: ctl.injected, code: r.error?.code ?? null, researchError: r.error instanceof C.ResearchError, sealed: r.sealed, outstanding: ctl.outstanding() };
    } else {
      assert.ok(['reader-early', 'reader-malformed', 'reader-multibyte'].includes(mode));
      const file = path.join(work(), 'tracked.jsonl');
      const rows = [{ text: 'abcd\u20ac\ud83d\ude00efghi' }, { n: 2 }];
      const text = mode === 'reader-malformed' ? '{bad json}\n' : rows.map(r => JSON.stringify(r)).join('\n') + '\n';
      writeFileSync(file, text);
      ctl.target = 'tracked.jsonl'; ctl.maxRead = 7; ctl.armed = true;
      let error = null; const got = []; const integrity = {};
      try {
        for (const row of IO.readJsonlStrict(file, { integrity })) {
          got.push(row); if (mode === 'reader-early') break;
        }
      } catch (e) { error = e; }
      result = { opened: ctl.opened, closed: ctl.closed, outstanding: ctl.outstanding(), code: error?.code ?? null, got, complete: integrity.complete === true, sha256: integrity.sha256 ?? null, expectedSha256: C.sha256Hex(text) };
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { ctl.armed = false; cleanup(); }
}
