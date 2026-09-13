import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DECISION_READ_MAX_ACTIVATION_ENTITIES,
  DECISION_READ_MAX_LINE_BYTES,
  DECISION_READ_MAX_TOTAL_BYTES,
  DECISION_READ_MAX_TOTAL_ROWS,
  readDecisionSourceSnapshot,
  readDecisionSourceSnapshotForTest,
} from '../learning/decision-read-snapshot.js';

const makeRoot = () => mkdtempSync(path.join(tmpdir(), 'cobra-decision-read-'));
const line = (value) => `${JSON.stringify(value)}\n`;
const seed = (root, { kill = false } = {}) => {
  const dir = path.join(root, 'learning');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'activations.jsonl'), line({ activationId: 'a-1', seq: 0 }));
  writeFileSync(path.join(dir, 'patterns.jsonl'), line({ patternId: 'p-1', seq: 0 }));
  writeFileSync(path.join(dir, 'prospective.jsonl'), line({ kind: 'DESIGN_SEALED', design: { candidateId: 'c-1' } }));
  if (kill) writeFileSync(path.join(dir, 'kill.json'), JSON.stringify({ state: 'KILLED', reason: 'operator', ts: 1 }));
  return dir;
};
const tree = (root) => {
  const visit = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return [{ path: relative, type: 'dir' }, ...visit(absolute, relative)];
    return [{ path: relative, type: entry.isSymbolicLink() ? 'link' : 'file', bytes: entry.isFile() ? readFileSync(absolute).toString('hex') : null }];
  });
  return visit(root);
};

test('stable complete capture is frozen, hashes exact bytes and store identity, and missing kill is explicit', () => {
  const root = makeRoot();
  try {
    seed(root);
    const first = readDecisionSourceSnapshot({ dataDir: root });
    const second = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(first.ok, true);
    assert.equal(first.authority, 'NONE');
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.activations), true);
    assert.equal(first.activations.length, 1);
    assert.equal(first.patterns.length, 1);
    assert.equal(first.prospective.length, 1);
    assert.deepEqual(first.kill, { state: 'ARMED', reason: null, ts: null });
    assert.equal(first.provenance.complete, true);
    assert.equal(first.provenance.files.kill.present, false);
    assert.match(first.provenance.canonicalStoreId, /^sha256:[a-f0-9]{64}$/);
    assert.match(first.provenance.sourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(first.provenance.sourceDigest, second.provenance.sourceDigest);
    assert.equal(first.provenance.canonicalStoreId, second.provenance.canonicalStoreId);

    const other = makeRoot();
    try {
      seed(other);
      const sameBytesElsewhere = readDecisionSourceSnapshot({ dataDir: other });
      assert.equal(sameBytesElsewhere.ok, true);
      assert.notEqual(sameBytesElsewhere.provenance.canonicalStoreId, first.provenance.canonicalStoreId);
      assert.notEqual(sameBytesElsewhere.provenance.sourceDigest, first.provenance.sourceDigest);
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reader performs no commissioning or filesystem writes', () => {
  const absent = path.join(tmpdir(), `cobra-decision-read-absent-${process.pid}-${Date.now()}`);
  assert.equal(existsSync(absent), false);
  assert.deepEqual(readDecisionSourceSnapshot({ dataDir: absent }), {
    ok: false, version: 'learning-decision-raw-snapshot-1', authority: 'NONE', code: 'DATA_DIR_NOT_FOUND', journal: null,
  });
  assert.equal(existsSync(absent), false);

  const root = makeRoot();
  try {
    seed(root, { kill: true });
    const before = tree(root);
    assert.equal(readDecisionSourceSnapshot({ dataDir: root }).ok, true);
    assert.deepEqual(tree(root), before, 'read creates, removes, renames, or rewrites nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing required history refuses whole rather than becoming an empty history', () => {
  const root = makeRoot();
  try {
    const dir = seed(root);
    rmSync(path.join(dir, 'patterns.jsonl'));
    const result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REQUIRED_HISTORY_MISSING');
    assert.equal(result.journal, 'patterns');
    assert.equal(Object.hasOwn(result, 'activations'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('oversized single line and total physical bytes are refused before a partial result exists', () => {
  const root = makeRoot();
  try {
    const dir = seed(root);
    writeFileSync(path.join(dir, 'patterns.jsonl'), `${' '.repeat(DECISION_READ_MAX_LINE_BYTES + 1)}\n`);
    let result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LINE_TOO_LARGE');
    assert.equal(Object.hasOwn(result, 'patterns'), false);

    writeFileSync(path.join(dir, 'patterns.jsonl'), line({ patternId: 'p-1' }));
    writeFileSync(path.join(dir, 'prospective.jsonl'), Buffer.alloc(DECISION_READ_MAX_TOTAL_BYTES + 1, 0x20));
    result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SOURCE_TOO_LARGE');
    assert.equal(Object.hasOwn(result, 'prospective'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('row and entity ceilings refuse the entire source instead of returning a prefix', () => {
  const root = makeRoot();
  try {
    const dir = seed(root);
    const repeated = line({ patternId: 'one' }).repeat(DECISION_READ_MAX_TOTAL_ROWS + 1);
    writeFileSync(path.join(dir, 'patterns.jsonl'), repeated);
    let result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ROW_LIMIT_EXCEEDED');
    assert.equal(Object.hasOwn(result, 'patterns'), false);

    writeFileSync(path.join(dir, 'patterns.jsonl'), line({ patternId: 'one' }));
    const activations = Array.from({ length: DECISION_READ_MAX_ACTIVATION_ENTITIES + 1 }, (_, index) => line({ activationId: `a-${index}` })).join('');
    writeFileSync(path.join(dir, 'activations.jsonl'), activations);
    result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENTITY_LIMIT_EXCEEDED');
    assert.equal(result.journal, 'activations');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('kill occupies the final aggregate row slot and cannot become row 10001', () => {
  const root = makeRoot();
  try {
    const dir = seed(root, { kill: true });
    writeFileSync(path.join(dir, 'patterns.jsonl'), '');
    writeFileSync(path.join(dir, 'prospective.jsonl'), '');
    const repeated = line({ activationId: 'same-entity' });
    writeFileSync(path.join(dir, 'activations.jsonl'), repeated.repeat(DECISION_READ_MAX_TOTAL_ROWS - 1));
    let result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, true);
    assert.equal(result.activations.length, DECISION_READ_MAX_TOTAL_ROWS - 1);
    assert.equal(result.provenance.files.kill.rows, 1);
    assert.equal(result.provenance.totalRows, DECISION_READ_MAX_TOTAL_ROWS);

    writeFileSync(path.join(dir, 'activations.jsonl'), repeated.repeat(DECISION_READ_MAX_TOTAL_ROWS));
    result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ROW_LIMIT_EXCEEDED');
    assert.equal(result.journal, 'kill');
    assert.equal(Object.hasOwn(result, 'activations'), false, 'row 10001 refuses the whole source, not a prefix');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed JSON and an unterminated final JSONL row are refused', () => {
  const root = makeRoot();
  try {
    const dir = seed(root);
    writeFileSync(path.join(dir, 'activations.jsonl'), '{"activationId":\n');
    let result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'JSON_INVALID');

    writeFileSync(path.join(dir, 'activations.jsonl'), JSON.stringify({ activationId: 'valid-but-not-terminated' }));
    result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'JOURNAL_NOT_NEWLINE_TERMINATED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed UTF-8 is refused before JSON interpretation', () => {
  const root = makeRoot();
  try {
    const dir = seed(root);
    writeFileSync(path.join(dir, 'patterns.jsonl'), Buffer.from([0xc3, 0x28, 0x0a]));
    const result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'JSON_UTF8_INVALID');
    assert.equal(result.journal, 'patterns');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an append between file reads invalidates the entire multi-file snapshot', () => {
  const root = makeRoot();
  try {
    const dir = seed(root);
    let injected = false;
    const result = readDecisionSourceSnapshotForTest({ dataDir: root }, {
      afterFileRead({ journal }) {
        if (journal === 'activations' && !injected) {
          injected = true;
          appendFileSync(path.join(dir, 'activations.jsonl'), line({ activationId: 'a-raced', seq: 0 }));
        }
      },
    });
    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SOURCE_CHANGED');
    assert.equal(result.journal, 'activations');
    assert.equal(Object.hasOwn(result, 'provenance'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same-size file replacement between reads invalidates source identity', () => {
  const root = makeRoot();
  try {
    const dir = seed(root);
    const target = path.join(dir, 'patterns.jsonl');
    const before = readFileSync(target);
    const replacement = path.join(dir, 'patterns.replacement');
    const alternate = Buffer.from(before.toString('utf8').replace('p-1', 'q-2'));
    assert.equal(alternate.length, before.length);
    writeFileSync(replacement, alternate);
    let injected = false;
    const result = readDecisionSourceSnapshotForTest({ dataDir: root }, {
      afterFileRead({ journal }) {
        if (journal === 'patterns' && !injected) {
          injected = true;
          rmSync(target);
          renameSync(replacement, target);
        }
      },
    });
    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SOURCE_CHANGED');
    // POSIX can observe the directory-entry replacement before checking the
    // individual file. Either identity check must refuse the whole snapshot.
    assert.ok(result.journal === null || result.journal === 'patterns');
    assert.equal(Object.hasOwn(result, 'provenance'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a symlinked journal escaping the store is refused and never read', (t) => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    const dir = seed(root);
    const outsideFile = path.join(outside, 'outside-patterns.jsonl');
    writeFileSync(outsideFile, line({ patternId: 'outside' }));
    rmSync(path.join(dir, 'patterns.jsonl'));
    try { symlinkSync(outsideFile, path.join(dir, 'patterns.jsonl'), 'file'); }
    catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') { t.skip('platform does not permit symlink creation'); return; }
      throw error;
    }
    assert.equal(lstatSync(path.join(dir, 'patterns.jsonl')).isSymbolicLink(), true);
    const result = readDecisionSourceSnapshot({ dataDir: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PATH_SYMLINK_REFUSED');
    assert.equal(result.journal, 'patterns');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
