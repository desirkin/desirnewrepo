import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJsonForTest, replaceJsonl } from '../lib/jsonl.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-atomic-'));
const wrappedIo = (overrides = {}) => ({
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  ...overrides,
});

test('atomicWriteJson tolerates only Windows EPERM from the post-rename directory fsync', () => {
  const dir = temp(); const file = path.join(dir, 'state.json'); let syncs = 0;
  const io = wrappedIo({ fsyncSync(fd) { syncs += 1; if (syncs === 2) throw Object.assign(new Error('directory fsync unsupported'), { code: 'EPERM' }); return fs.fsyncSync(fd); } });
  atomicWriteJsonForTest(file, { durable: true }, { sync: true, io, platform: 'win32' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { durable: true });
  assert.equal(syncs, 2, 'the file was synced before the unsupported directory sync');
});

test('atomicWriteJson never swallows a file fsync failure, even on Windows', () => {
  const dir = temp(); const file = path.join(dir, 'state.json'); fs.writeFileSync(file, '{"old":true}'); let syncs = 0;
  const expected = Object.assign(new Error('file fsync failed'), { code: 'EPERM' });
  const io = wrappedIo({ fsyncSync() { syncs += 1; throw expected; } });
  assert.throws(() => atomicWriteJsonForTest(file, { old: false }, { sync: true, io, platform: 'win32' }), error => error === expected);
  assert.equal(syncs, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { old: true }, 'rename never occurs after a failed file sync');
});

test('atomicWriteJson surfaces Linux directory fsync failures and non-EPERM Windows failures', () => {
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EACCES']]) {
    const dir = temp(); const file = path.join(dir, 'state.json'); let syncs = 0;
    const io = wrappedIo({ fsyncSync(fd) { syncs += 1; if (syncs === 2) throw Object.assign(new Error(`${platform} directory sync failed`), { code }); return fs.fsyncSync(fd); } });
    assert.throws(() => atomicWriteJsonForTest(file, { platform }, { sync: true, io, platform }), error => error?.code === code);
    assert.equal(syncs, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { platform }, 'rename preceded the reported directory durability failure');
  }
});

test('atomicWriteJson preserves the file-fsync error when descriptor close also fails', () => {
  const dir = temp(); const file = path.join(dir, 'state.json');
  const fsyncError = Object.assign(new Error('primary fsync failure'), { code: 'EIO' });
  const io = wrappedIo({ fsyncSync() { throw fsyncError; }, closeSync(fd) { fs.closeSync(fd); throw Object.assign(new Error('secondary close failure'), { code: 'EBADF' }); } });
  assert.throws(() => atomicWriteJsonForTest(file, { value: 1 }, { sync: true, io, platform: 'linux' }), error => error === fsyncError);
  assert.equal(fs.existsSync(file), false);
});

test('replaceJsonl uses the same portable post-rename directory durability boundary', () => {
  const dir = temp(); const file = path.join(dir, 'observations.jsonl');
  replaceJsonl(file, [{ n: 1 }, { n: 2 }]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"n":1}\n{"n":2}\n');
});
