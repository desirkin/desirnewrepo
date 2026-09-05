// Shared RUMOR-2 test journal — the SAME closed contract and laws as the
// production journal stores (atomic batch, first-truth dedupe of exact
// crash re-appends, altered-payload corruption refusal, implicit contiguous
// sequence), over a plain shared array so restart pairs literally share one
// durable log and tests can assert on the raw stream.
import { canonicalJson } from '../../rumor2/truth.js';

export const memJournal = (arr, { failAppends = () => false, failReads = () => false } = {}) => ({
  async read() {
    if (failReads()) return { unavailable: 'injected journal read failure' };
    return { events: structuredClone(arr), lastSeq: arr.length };
  },
  async append(records) {
    if (failAppends(records)) return { ok: false, reason: 'UNAVAILABLE: injected journal append failure' };
    const add = [];
    for (const rec of records) {
      if (typeof rec.sourceEventId === 'string') {
        const ex = [...arr, ...add].find((e) => e.type === rec.type && e.sourceEventId === rec.sourceEventId);
        if (ex) {
          if (canonicalJson(ex) !== canonicalJson(rec)) return { ok: false, reason: 'CORRUPTION: duplicate event identity with an altered payload' };
          continue; // exact crash re-append — already durable
        }
      }
      add.push(structuredClone(rec));
    }
    arr.push(...add); // atomic: nothing lands unless the whole batch does
    return { ok: true, lastSeq: arr.length };
  },
});
