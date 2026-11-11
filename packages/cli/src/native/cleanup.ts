// Deleting old launch and hook session records, with their archived
// originals. Records can hold private code, logs or printed secrets, and the
// global hook writes one for every hooked session, so people need an easy way
// to clear them. Retention stays manual: nothing here runs on its own.
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultStateDirectory } from '@nord-forge/fonn-core/state';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 24 * 60 * 60 * 1000;

export interface OldRecord {
  launchId: string;
  origin: 'launch' | 'hook';
  /** The newest file in the record: its last activity. */
  lastActivity: string;
  bytes: number;
}

export interface CleanupSummary {
  olderThanDays: number;
  records: OldRecord[];
  bytes: number;
}

/** Newest modification time and total size of a record folder. Links are counted, never followed. */
async function scan(folder: string): Promise<{ newest: number; bytes: number }> {
  let newest = 0;
  let bytes = 0;
  const pending = [folder];
  while (pending.length) {
    const current = pending.pop()!;
    const info = await lstat(current);
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory()) {
      for (const entry of await readdir(current)) pending.push(path.join(current, entry));
    } else {
      bytes += info.size;
    }
  }
  return { newest, bytes };
}

async function nativeFolder(stateDirectory: string): Promise<string | undefined> {
  const native = path.join(path.resolve(stateDirectory), 'native');
  const info = await lstat(native).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return undefined;
  return realpath(native);
}

/** Records whose last activity is older than the given number of days, oldest first. */
export async function findOldRecords(olderThanDays: number, stateDirectory = getDefaultStateDirectory(), now = Date.now()): Promise<CleanupSummary> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) throw new Error('Choose a whole number of days from 1 to 3650.');
  const native = await nativeFolder(stateDirectory);
  const records: OldRecord[] = [];
  if (native) {
    const cutoff = now - olderThanDays * DAY;
    for (const entry of await readdir(native)) {
      if (!ID.test(entry)) continue;
      const folder = path.join(native, entry);
      const info = await lstat(folder).catch(() => undefined);
      if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
      const { newest, bytes } = await scan(folder);
      if (newest >= cutoff) continue;
      const record = await readFile(path.join(folder, 'launch.json'), 'utf8').then((text) => JSON.parse(text) as { origin?: string }).catch(() => undefined);
      records.push({ launchId: entry, origin: record?.origin === 'hook' ? 'hook' : 'launch', lastActivity: new Date(newest).toISOString(), bytes });
    }
  }
  records.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));
  return { olderThanDays, records, bytes: records.reduce((total, record) => total + record.bytes, 0) };
}

/**
 * Deletes the records in a summary. Each one is checked again first, so a
 * record that became active since the summary was made is kept.
 */
export async function deleteOldRecords(summary: CleanupSummary, stateDirectory = getDefaultStateDirectory(), now = Date.now()): Promise<{ deleted: string[]; kept: string[] }> {
  const native = await nativeFolder(stateDirectory);
  const current = new Set((await findOldRecords(summary.olderThanDays, stateDirectory, now)).records.map((record) => record.launchId));
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const record of summary.records) {
    if (!native || !ID.test(record.launchId) || !current.has(record.launchId)) { kept.push(record.launchId); continue; }
    const folder = path.join(native, record.launchId);
    const info = await lstat(folder).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) { kept.push(record.launchId); continue; }
    // rm does not follow links inside the folder, so only this record goes.
    await rm(folder, { recursive: true });
    deleted.push(record.launchId);
  }
  return { deleted, kept };
}

/** "2.4 MB" style sizes for summaries. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
