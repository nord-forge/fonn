import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedDirectory } from './storage.js';

/**
 * Crash recovery is deliberately manual: inspect pid/createdAt/owner, verify that
 * no process still owns this session, then remove only the stale lock file.
 * Never infer staleness from age, and never unlink a competing owner's lock.
 */
export async function acquireResumeLock(sessionId: string, stateDirectory: string): Promise<() => Promise<void>> {
  if (!sessionId.trim()) throw new Error('Cannot lock an empty session ID');
  const directory = await checkedDirectory(join(stateDirectory, 'resume-locks'), true);
  await chmod(directory, 0o700);
  const digest = createHash('sha256').update(sessionId).digest('hex');
  const path = join(directory, `${digest}.lock`);
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`This session already has a resume lock: ${path}. Another resume may be active. If its process ended, inspect the lock owner/PID and manually remove only the verified stale lock; locks are never removed automatically.`);
    }
    throw error;
  }
  const owner = randomUUID();
  const identity = await file.stat();
  try {
    await file.writeFile(`${JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await file.sync();
  } finally { await file.close(); }
  let released = false;
  return async () => {
    if (released) return;
    // Re-check directory components and the exact inode, then verify our owner token.
    // If anything changed, leave it untouched for human inspection.
    await checkedDirectory(directory, false);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.dev !== identity.dev || entry.ino !== identity.ino || entry.nlink !== 1) throw new Error('Resume lock ownership changed; the replacement was left untouched.');
    const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await current.stat();
      if (info.dev !== identity.dev || info.ino !== identity.ino || info.size > 4096) throw new Error('Resume lock ownership changed; the replacement was left untouched.');
      let metadata: unknown;
      try { metadata = JSON.parse(await current.readFile('utf8')); } catch { throw new Error('Resume lock ownership could not be verified; it was left untouched.'); }
      if (!metadata || typeof metadata !== 'object' || !('owner' in metadata) || metadata.owner !== owner) throw new Error('Resume lock ownership changed; the replacement was left untouched.');
    } finally { await current.close(); }
    const latest = await lstat(path);
    if (latest.dev !== identity.dev || latest.ino !== identity.ino || latest.isSymbolicLink()) throw new Error('Resume lock ownership changed; the replacement was left untouched.');
    await unlink(path);
    released = true;
  };
}
