import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deleteOldRecords, findOldRecords, formatBytes } from '../../src/native/cleanup.js';

const DAY = 24 * 60 * 60 * 1000;

async function record(native: string, id: string, ageDays: number, origin?: 'hook') {
  const folder = path.join(native, id);
  await mkdir(path.join(folder, 'artifacts'), { recursive: true });
  await writeFile(path.join(folder, 'launch.json'), JSON.stringify(origin ? { origin } : {}));
  await writeFile(path.join(folder, 'artifacts', 'original.json'), 'x'.repeat(1000));
  const when = new Date(Date.now() - ageDays * DAY);
  for (const file of [path.join(folder, 'artifacts', 'original.json'), path.join(folder, 'launch.json'), path.join(folder, 'artifacts'), folder]) await utimes(file, when, when);
  return folder;
}

test('old records are found by last activity and deleted, recent ones and links are kept', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fonn-cleanup-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const native = path.join(base, 'state', 'native');
  const old = '11111111-1111-4111-8111-111111111111';
  const hook = '22222222-2222-4222-8222-222222222222';
  const recent = '33333333-3333-4333-8333-333333333333';
  const revived = '44444444-4444-4444-8444-444444444444';
  await record(native, old, 60);
  await record(native, hook, 45, 'hook');
  await record(native, recent, 5);
  const revivedFolder = await record(native, revived, 40);
  // A link that looks like a record is never followed or deleted.
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(native, '55555555-5555-4555-8555-555555555555'));
  await mkdir(path.join(native, 'not-a-record'));

  const summary = await findOldRecords(30, path.join(base, 'state'));
  assert.deepEqual(summary.records.map((entry) => entry.launchId), [old, hook, revived], 'oldest first, recent and links left out');
  assert.equal(summary.records.find((entry) => entry.launchId === hook)!.origin, 'hook');
  assert.ok(summary.bytes > 2000);

  // A record that becomes active after the summary is kept.
  await writeFile(path.join(revivedFolder, 'artifacts', 'new.json'), 'fresh');
  const result = await deleteOldRecords(summary, path.join(base, 'state'));
  assert.deepEqual(result.deleted.sort(), [hook, old].sort());
  assert.deepEqual(result.kept, [revived]);
  assert.deepEqual((await readdir(native)).sort(), ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', 'not-a-record'].sort());
  assert.deepEqual(await readdir(outside), []);

  await assert.rejects(findOldRecords(0, path.join(base, 'state')), /whole number of days/);
  assert.deepEqual((await findOldRecords(30, path.join(base, 'missing'))).records, []);
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB');
});

test('fonn records clean lists first, needs a terminal or --yes, and supports a dry run', async (t) => {
  const { dispatch } = await import('../../src/cli/main.js');
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fonn-cleanup-cli-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const state = path.join(base, 'state');
  await record(path.join(state, 'native'), '66666666-6666-4666-8666-666666666666', 90, 'hook');
  const run = async (args: string[], extra: Record<string, unknown> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(['records', 'clean', ...args, '--state-dir', state], { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); }, interactive: false, env: {}, ...extra } as never).catch((error: Error) => { err.push(error.message); return 2; });
    return { code, out: out.join(''), err: err.join('') };
  };
  const dry = await run(['--older-than', '30', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /1 records older than 30 days \(1 from hook sessions\)/);
  assert.match(dry.out, /Dry run: nothing was deleted\./);
  const refused = await run(['--older-than', '30']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /Run it in a terminal to confirm, or pass --yes/);
  const declined = await run(['--older-than', '30'], { interactive: true, ask: async () => 'n' });
  assert.match(declined.out, /Nothing was deleted\./);
  assert.equal((await readdir(path.join(state, 'native'))).length, 1);
  const done = await run(['--older-than', '30', '--yes']);
  assert.match(done.out, /Deleted 1 records\./);
  assert.equal((await readdir(path.join(state, 'native'))).length, 0);
  assert.match((await run(['--older-than', '30'])).out, /No records older than 30 days\./);
});
