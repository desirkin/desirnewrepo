// Loaded with --require in an isolated child ONLY. No patch in the parent test runner.
if (process.env.SERPENT_ACCEPTANCE_CHILD_MODE) {
  const fs = require('node:fs');
  const path = require('node:path');
  const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync };
  const tracked = new Map();
  const control = globalThis.__serpentOwnerFs = {
    armed: false, target: '', closeFault: false, maxRead: null,
    opened: 0, closed: 0, injected: 0,
    outstanding: () => tracked.size,
  };
  fs.openSync = function (file, ...args) {
    const fd = original.open.call(fs, file, ...args);
    if (control.armed && path.basename(String(file)) === control.target) {
      tracked.set(fd, control.target); control.opened++;
    }
    return fd;
  };
  fs.closeSync = function (fd) {
    const watched = tracked.has(fd);
    const result = original.close.call(fs, fd);
    if (watched) {
      tracked.delete(fd); control.closed++;
      if (control.closeFault && control.injected === 0) {
        control.injected++;
        // A reported close failure can occur after descriptor release. Never retry blindly.
        const e = new Error('synthetic owner acceptance close failure'); e.code = 'EIO'; throw e;
      }
    }
    return result;
  };
  fs.readSync = function (fd, buffer, offset, length, position) {
    const n = tracked.has(fd) && control.maxRead ? Math.min(length, control.maxRead) : length;
    return original.read.call(fs, fd, buffer, offset, n, position);
  };
  require('node:module').syncBuiltinESMExports();
}
