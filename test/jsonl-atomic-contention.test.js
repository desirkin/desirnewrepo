import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJsonForTest } from '../lib/jsonl.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-rename-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"old":true}');
  return { dir, file };
}
const errorWith = code => Object.assign(new Error('injected rename error'), { code });

test('Windows transient rename EPERM retries identical bytes without removing the destination', t => {
  const { dir, file } = fixture(t);
  const waits = [], sources = []; let tries = 0, writes = 0, syncs = 0;
  const io = {
    writeFileSync(...args) { writes++; return fs.writeFileSync(...args); },
    fsyncSync(fd) { syncs++; if (syncs === 2) throw errorWith('EPERM'); return fs.fsyncSync(fd); },
    renameSync(source, target) {
      assert.equal(target, file);
      assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
      assert.equal(fs.readFileSync(source, 'utf8'), '{"value":2}');
      sources.push(source);
      if (++tries < 4) throw errorWith('EPERM');
      fs.renameSync(source, target);
    },
    sleepSync(ms) { waits.push(ms); },
    unlinkSync() { assert.fail('successful retry must not unlink any path'); },
  };
  atomicWriteJsonForTest(file, { value: 2 }, { sync: true, io, platform: 'win32' });
  assert.deepEqual(waits, [1, 2, 4]);
  assert.equal(new Set(sources).size, 1);
  assert.equal(writes, 1); assert.equal(syncs, 2);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"value":2}');
});

test('persistent Windows EPERM is bounded and preserves both prior target and another writer temp', t => {
  const { dir, file } = fixture(t);
  const foreignTemp = path.join(dir, 'other-writer.tmp'); fs.writeFileSync(foreignTemp, 'keep');
  const expected = errorWith('EPERM'); const waits = [], removed = []; let tries = 0, ownedTemp;
  const io = {
    renameSync(source) { ownedTemp = source; tries++; throw expected; },
    sleepSync(ms) { waits.push(ms); },
    unlinkSync(target) { assert.equal(target, ownedTemp); removed.push(target); fs.unlinkSync(target); },
  };
  assert.throws(() => atomicWriteJsonForTest(file, { value: 2 }, { io, platform: 'win32' }), e => e === expected);
  assert.equal(tries, 8); assert.deepEqual(waits, [1, 2, 4, 8, 16, 16, 16]);
  assert.equal(waits.reduce((a, b) => a + b, 0), 63);
  assert.deepEqual(removed, [ownedTemp]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
  assert.equal(fs.readFileSync(foreignTemp, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['other-writer.tmp', 'state.json']);
});

test('non-Windows EPERM and other Windows rename errors still fail immediately', t => {
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EACCES'], ['win32', 'ENOENT'], ['win32', 'EIO']]) {
    const { file } = fixture(t); const expected = errorWith(code); let tries = 0;
    const io = {
      renameSync() { tries++; throw expected; },
      sleepSync() { assert.fail('this error must not be retried'); },
    };
    assert.throws(() => atomicWriteJsonForTest(file, { value: 2 }, { io, platform }), e => e === expected);
    assert.equal(tries, 1); assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
  }
});
