import {
  openDailyShardedStudyRunner, sealDailyShardTraversalOutput,
} from '../../learning/daily-sharded-study-runner.js';
import { openBroadDayReader } from '../../market-lab/broad-day-reader.js';

const [archiveRoot, stateRoot, jobId, declared, start, end, asOf, max] = process.argv.slice(2);
let runner;
try {
  runner = await openDailyShardedStudyRunner({
    archiveRoot, stateRoot, jobId,
    openBroadDayReader,
    declaredTs: Number(declared), dayStartTs: Number(start), dayEndTs: Number(end), asOfTs: Number(asOf),
    consumeShard: async ({ marketDay, receipt }) => sealDailyShardTraversalOutput({ marketDay, receipt }),
  });
  const result = await runner.execute({ maxShards: Number(max) });
  await runner.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  try { await runner?.close(); } catch {}
  process.stderr.write(`${JSON.stringify({ code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error).slice(0, 500) })}\n`);
  process.exitCode = 1;
}
