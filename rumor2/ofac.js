// RUMOR-2B1 — bounded fail-closed parsing and deterministic snapshot/diff
// of the official OFAC SDN list (Sanctions List Service, classic 12-column
// SDN.CSV) into provider items for the EXISTING RUMOR-2 evidence pipeline.
//
// OFAC TRUTH, NOT BLOCKCHAIN ATTRIBUTION: this module records exactly what
// OFAC itself published — an entity was added, modified, or removed, and
// any digital-currency address the official record explicitly carries,
// preserved verbatim (never lowercased, never re-encoded, never expanded
// into wallets, clusters, or ownership). It concludes nothing about
// markets. Fetching is separate from believing: everything accepted here
// still passes the one authoritative prepared-transaction trust gate.
//
// Snapshot model: a successfully parsed dataset has a deterministic
// content identity (order-immune hash over per-record identities). The
// FIRST accepted dataset is a BASELINE — one bounded baseline observation,
// never a per-record event explosion. Later datasets diff against the
// previously ACCEPTED snapshot into explicit ADD / MODIFY / REMOVE items.
// A restart, a replayed download, or a reordered response yields the same
// identities and therefore no fictitious changes.
import { createHash } from 'node:crypto';
import { MAX_TITLE_CHARS, MAX_SUMMARY_CHARS } from './truth.js';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export const OFAC_MAX_RECORDS = 100_000; // structural sanity bound on the dataset
export const OFAC_MAX_LINE_CHARS = 8_000;
export const OFAC_MAX_CHANGES = 512; // beyond this a "diff" is a rewrite — fail closed, never a flood
export const OFAC_SNAPSHOT_FILE = 'ofac-snapshot.json';
export const OFAC_SDN_COLUMNS = 12; // classic SDN.CSV: ent_num..remarks, no header row

// strict CSV line parser for the classic SDN format: comma-separated,
// double-quoted fields with "" escapes, unquoted fields trimmed, the
// literal token -0- meaning null. Malformed structure returns null.
export function parseSdnCsvLine(line) {
  const fields = [];
  let i = 0;
  const n = line.length;
  while (true) {
    let field = '';
    // skip leading spaces before a field
    while (i < n && line[i] === ' ') i++;
    if (line[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) return null; // unterminated quote
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else field += line[i++];
      }
      while (i < n && line[i] === ' ') i++;
      if (i < n && line[i] !== ',') return null; // junk after closing quote
    } else {
      while (i < n && line[i] !== ',') field += line[i++];
      field = field.trim();
    }
    fields.push(field === '-0-' ? null : field);
    if (i >= n) break;
    i++; // consume the comma
  }
  return fields;
}

// Strict fail-closed parse of one full SDN.CSV body. Any malformed line,
// duplicate uid, or structural violation rejects the WHOLE dataset: a
// partially trusted sanctions list is worse than an honestly failed fetch.
export function parseSdnCsv(text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty dataset body' };
  const records = new Map();
  const lines = text.split('\n');
  if (lines.length > OFAC_MAX_RECORDS) return { ok: false, reason: `dataset exceeds ${OFAC_MAX_RECORDS} lines` };
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    if (line === '\x1a') continue; // the official file ends with a classic DOS EOF marker (SUB) on its own line

    if (line.length > OFAC_MAX_LINE_CHARS) return { ok: false, reason: 'dataset line exceeds bounded length' };
    const fields = parseSdnCsvLine(line);
    if (fields === null || fields.length !== OFAC_SDN_COLUMNS) return { ok: false, reason: `malformed SDN row (${fields === null ? 'bad quoting' : `${fields.length} columns`})` };
    const uidRaw = fields[0];
    if (uidRaw === null || !/^\d{1,10}$/.test(uidRaw)) return { ok: false, reason: `malformed SDN uid '${String(uidRaw).slice(0, 16)}'` };
    const uid = Number(uidRaw);
    if (records.has(uid)) return { ok: false, reason: `duplicate SDN uid ${uid}` };
    if (typeof fields[1] !== 'string' || fields[1].length === 0) return { ok: false, reason: `SDN uid ${uid} lacks a name` };
    records.set(uid, {
      name: fields[1].slice(0, 350),
      sdnType: fields[2] ?? null,
      programs: fields[3] ?? null,
      remarks: fields[11] ?? null,
      // per-record content identity over the exact official row — the same
      // record in a reordered response hashes identically
      hash: sha1(line),
    });
  }
  if (records.size === 0) return { ok: false, reason: 'dataset parsed to zero records — refusing an empty sanctions list' };
  return { ok: true, records };
}

// order-immune deterministic identity of a whole accepted dataset
export function sdnDatasetIdentity(records) {
  const pairs = [...records.entries()].map(([uid, r]) => [uid, r.hash]).sort((a, b) => a[0] - b[0]);
  return sha1(JSON.stringify(pairs));
}

// digital-currency address references exactly as the official record
// supplies them: "Digital Currency Address - <TYPE> <address>". The address
// is preserved VERBATIM — case and encoding may be semantic on some
// networks, so nothing is normalized, inferred, or expanded.
export function extractDigitalCurrencyAddresses(remarks) {
  if (typeof remarks !== 'string') return [];
  const out = [];
  for (const m of remarks.matchAll(/Digital Currency Address - ([A-Z0-9]{2,12}) ([1-9A-HJ-NP-Za-km-z0-9:.\-_]{4,120})/g)) {
    out.push({ currency: m[1], address: m[2] });
    if (out.length >= 32) break;
  }
  return out;
}

// deterministic explicit changes between the previously ACCEPTED snapshot
// (uid -> {name, hash}) and a newly parsed dataset — sorted by kind then
// uid so replays and reorders always yield the same sequence
export function diffSdnSnapshots(prev, next) {
  const changes = [];
  for (const [uid, rec] of next) {
    const old = prev.get(uid);
    if (!old) changes.push({ change: 'ADD', uid, record: rec });
    else if (old.hash !== rec.hash) changes.push({ change: 'MODIFY', uid, record: rec });
  }
  for (const [uid, old] of prev) if (!next.has(uid)) changes.push({ change: 'REMOVE', uid, priorName: old.name });
  const order = { ADD: 0, MODIFY: 1, REMOVE: 2 };
  changes.sort((a, b) => order[a.change] - order[b.change] || a.uid - b.uid);
  return changes;
}

const shortHash = (h) => String(h).slice(0, 12);

function changeItem(chg, datasetHash, listUrl) {
  if (chg.change === 'REMOVE') {
    return {
      title: `OFAC SDN REMOVE: ${chg.priorName}`.slice(0, MAX_TITLE_CHARS),
      summary: `uid=${chg.uid}; change=REMOVE; name=${chg.priorName}; note=record no longer present in official dataset ${shortHash(datasetHash)}`.slice(0, MAX_SUMMARY_CHARS),
      link: listUrl,
      // the removal identity is anchored to the dataset version that
      // removed it: re-diffing the same transition is the SAME observation
      guid: `sdn-${chg.uid}@removed-${shortHash(datasetHash)}`,
      publishedTs: null, // the CSV states no per-record clock — UNKNOWN stays unknown
    };
  }
  const r = chg.record;
  const addrs = extractDigitalCurrencyAddresses(r.remarks);
  const addrText = addrs.length > 0 ? addrs.map((a) => `${a.currency} ${a.address}`).join(' | ') : 'NONE_STATED';
  return {
    title: `OFAC SDN ${chg.change}: ${r.name}`.slice(0, MAX_TITLE_CHARS),
    summary: [
      `uid=${chg.uid}`,
      `change=${chg.change}`,
      `name=${r.name}`,
      `type=${r.sdnType ?? 'NONE_STATED'}`,
      `programs=${r.programs ?? 'NONE_STATED'}`,
      `digitalCurrencyAddresses=${addrText}`,
      `remarks=${r.remarks ?? 'NONE_STATED'}`,
    ]
      .join('; ')
      .slice(0, MAX_SUMMARY_CHARS),
    link: listUrl,
    // content-versioned record identity: the same record content is the
    // same observation across polls, restarts, and reordered responses; a
    // true modification is a NEW observation that never impersonates the old
    guid: `sdn-${chg.uid}@${shortHash(r.hash)}`,
    publishedTs: null,
  };
}

// Turn one successfully parsed dataset plus the previously accepted
// snapshot state into bounded provider items + the snapshot to commit once
// every item durably settles. prevAnchor is the durable checkpoint anchor
// ({hash, recordCount, acceptedTs} or null); prevRecords is the verified
// snapshot detail (uid -> {name, hash}) or null when unavailable.
export function buildOfacUpdate({ prevAnchor, prevRecords, records, listUrl }) {
  const datasetHash = sdnDatasetIdentity(records);
  // structural sanity: a dataset that silently vanishes half the accepted
  // list is refused no matter what HTTP said — fail closed, keep truth
  if (prevAnchor && prevAnchor.recordCount >= 10 && records.size < prevAnchor.recordCount / 2)
    return { ok: false, reason: `suspicious mass deletion: ${records.size} records vs accepted ${prevAnchor.recordCount} — fail closed` };
  if (prevAnchor && prevAnchor.hash === datasetHash) return { ok: true, kind: 'UNCHANGED', items: [], datasetHash, counts: { adds: 0, modifies: 0, removes: 0 } };
  if (!prevAnchor || !prevRecords) {
    // BASELINE: first accepted snapshot (or snapshot detail honestly
    // unavailable — the diff basis is gone, so the ear re-baselines rather
    // than inventing changes). ONE bounded observation, zero per-record events.
    const note = prevAnchor ? 'diff basis unavailable — re-baselined; intervening changes were not individually observed' : 'first accepted snapshot';
    return {
      ok: true,
      kind: 'BASELINE',
      datasetHash,
      counts: { adds: 0, modifies: 0, removes: 0 },
      items: [
        {
          title: 'OFAC SDN baseline snapshot accepted',
          summary: `datasetHash=${datasetHash}; records=${records.size}; note=${note}`.slice(0, MAX_SUMMARY_CHARS),
          link: listUrl,
          guid: `sdn-baseline@${shortHash(datasetHash)}`,
          publishedTs: null,
        },
      ],
    };
  }
  const changes = diffSdnSnapshots(prevRecords, records);
  if (changes.length > OFAC_MAX_CHANGES)
    return { ok: false, reason: `dataset diff carries ${changes.length} changes (> ${OFAC_MAX_CHANGES}) — a rewrite this large is withheld, not flooded` };
  const counts = {
    adds: changes.filter((c) => c.change === 'ADD').length,
    modifies: changes.filter((c) => c.change === 'MODIFY').length,
    removes: changes.filter((c) => c.change === 'REMOVE').length,
  };
  return { ok: true, kind: 'DIFF', datasetHash, counts, items: changes.map((c) => changeItem(c, datasetHash, listUrl)) };
}

// snapshot persistence payload (bounded detail needed to diff the NEXT
// dataset); its truth anchor — the dataset hash — lives in the validated
// durable checkpoint, so a payload that fails to re-derive that exact hash
// is honestly discarded and the ear re-baselines instead of trusting it
export function ofacSnapshotPayload(records, datasetHash) {
  return {
    version: 1,
    datasetHash,
    records: [...records.entries()].map(([uid, r]) => [uid, r.name, r.hash]).sort((a, b) => a[0] - b[0]),
  };
}

export function verifyOfacSnapshotPayload(payload, expectedHash) {
  try {
    if (payload === null || typeof payload !== 'object' || payload.version !== 1 || !Array.isArray(payload.records)) return null;
    const records = new Map();
    for (const row of payload.records) {
      if (!Array.isArray(row) || row.length !== 3) return null;
      const [uid, name, hash] = row;
      if (!Number.isSafeInteger(uid) || uid < 0 || typeof name !== 'string' || typeof hash !== 'string') return null;
      if (records.has(uid)) return null;
      records.set(uid, { name, hash });
    }
    const derived = sha1(JSON.stringify([...records.entries()].map(([uid, r]) => [uid, r.hash]).sort((a, b) => a[0] - b[0])));
    if (derived !== expectedHash) return null; // stale or tampered detail — not the accepted snapshot
    return records;
  } catch {
    return null;
  }
}
