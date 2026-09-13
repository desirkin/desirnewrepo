// The gate over the offline guard's evidence (N01/N02): ANY record in the ordinary suite's log fails the run, whether or
// not the application caught the denial. Usage: node test/helpers/offline-gate.mjs <log> [--allow-run selftest:*]
import { existsSync, readFileSync } from 'node:fs';
const file = process.argv[2]; if (!file) { console.error('usage: offline-gate.mjs <evidence.jsonl>'); process.exit(2); }
const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'UNPARSEABLE', raw: l.slice(0, 80) }; } }) : [];
const unexpected = rows.filter((r) => !String(r.run ?? '').startsWith('selftest:'));
const byFile = {}; for (const r of unexpected) { const k = `${r.testFile ?? '?'} ${r.kind} ${r.host}:${r.port}`; byFile[k] = (byFile[k] ?? 0) + 1; }
console.log(JSON.stringify({ evidence: file, records: rows.length, unexpected: unexpected.length, byAttempt: byFile }));
process.exit(unexpected.length ? 1 : 0);
