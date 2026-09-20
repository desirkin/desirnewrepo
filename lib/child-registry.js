// PUBLISH-FIX-83 second pass — every child process the program spawns (the gate study, the mover backfill) is tracked here so
// the ordered shutdown can end it. Before this, a SIGTERM to the parent left a 768 MB study child running and writing lesson
// files into the directory the NEXT instance was booting on.
const children = new Set();
export function trackChild(child) {
  if (!child || typeof child.on !== 'function') return child;
  children.add(child);
  const forget = () => children.delete(child);
  child.once('exit', forget); child.once('close', forget); child.once('error', forget); // a child that failed to spawn emits only 'error'
  return child;
}
export function liveChildren() { return [...children].filter((c) => c.exitCode === null && c.signalCode === null); }
export function killChildren(signal = 'SIGTERM') {
  let n = 0;
  for (const c of liveChildren()) { try { c.kill(signal); n += 1; } catch { /* already gone */ } }
  return n;
}
