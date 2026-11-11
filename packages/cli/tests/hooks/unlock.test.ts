import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { dispatch, type CliDependencies } from '../../src/cli/main.js';
import { applyHookPlan, HookConflictError, planHook, unlockHooks } from '../../src/hooks/index.js';
import { credentialName, maskSecrets, redactForDisplay } from '../../src/hooks/redact.js';
import { hookFixture } from './fixture.js';

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(done => child.once('exit', done));
  return child.pid!;
}

function cli(options: CliDependencies['hookOptions']) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); }, interactive: false, env: {}, hookOptions: options } };
}

test('a lock left by an unfinished run blocks install with the unlock hint, and fonn hooks unlock clears only that', async t => {
  const f = await hookFixture(t, 'unlock');
  const settings = path.join(f.home, '.claude', 'settings.json');
  const codexHooks = path.join(f.home, '.codex', 'hooks.json');
  await mkdir(path.dirname(settings));
  await mkdir(path.dirname(codexHooks));
  await writeFile(settings, '{}\n');
  await writeFile(codexHooks, '{"hooks": {}}\n');
  const claudeLock = path.join(path.dirname(settings), '.settings.json.fonn-lock');
  const codexLock = path.join(path.dirname(codexHooks), '.hooks.json.fonn-lock');
  await writeFile(claudeLock, JSON.stringify({ pid: await deadPid(), createdAt: new Date().toISOString() }));
  await writeFile(codexLock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

  await assert.rejects(applyHookPlan(await planHook('claude', 'install', f.options), f.options),
    new RegExp(`A lock from an earlier Fonn run that did not finish is left at ${claudeLock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. If no other Fonn is changing hooks, run fonn hooks unlock\\.`));
  assert.equal(await readFile(settings, 'utf8'), '{}\n');
  // Fonn never removes a lock on its own.
  assert.equal((await lstat(claudeLock)).isFile(), true);
  await assert.rejects(applyHookPlan(await planHook('codex', 'install', f.options), f.options), /Another Fonn change to .* is in progress\. Retry after it finishes\./);

  const run = cli(f.options);
  assert.equal(await dispatch(['hooks', 'unlock'], run.deps), 0);
  const text = run.out.join('');
  assert.match(text, /Claude Code: removed .*left by a Fonn run that did not finish/);
  assert.match(text, /Codex: kept .*another Fonn change is still in progress/);
  assert.match(text, /Crush: no lock\./);
  await assert.rejects(lstat(claudeLock), { code: 'ENOENT' });
  assert.equal((await lstat(codexLock)).isFile(), true);
  assert.equal(await readFile(settings, 'utf8'), '{}\n');
  assert.equal(await readFile(codexHooks, 'utf8'), '{"hooks": {}}\n');

  // After unlock, install works.
  assert.equal((await applyHookPlan(await planHook('claude', 'install', f.options), f.options)).current, true);

  // An old lock counts as left over even with a live owner, and --agent limits the scope.
  await writeFile(codexLock, JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  const results = await unlockHooks(['codex'], f.options);
  assert.deepEqual(results.map(result => [result.agent, result.action]), [['codex', 'removed']]);
  // An unreadable lock is judged by its age.
  await writeFile(claudeLock, '');
  assert.equal((await unlockHooks(['claude'], f.options))[0]!.action, 'kept');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(claudeLock, old, old);
  const scoped = cli(f.options);
  assert.equal(await dispatch(['hooks', 'unlock', '--agent', 'claude'], scoped.deps), 0);
  assert.match(scoped.out.join(''), /^Claude Code: removed/);
  assert.doesNotMatch(scoped.out.join(''), /Codex/);
});

test('fonn help hooks lists unlock', async () => {
  const run = cli({});
  assert.equal(await dispatch(['help', 'hooks'], run.deps), 0);
  assert.match(run.out.join(''), /fonn hooks unlock \[--agent <agent>\]\.\.\./);
});

test('a config link retargeted right after the rename is reported, not called installed', async t => {
  const f = await hookFixture(t, 'retarget-after');
  const file = path.join(f.home, '.claude', 'settings.json');
  const a = path.join(f.root, 'dotfiles', 'a.json');
  const b = path.join(f.root, 'dotfiles', 'b.json');
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.dirname(a), { recursive: true });
  await writeFile(a, '{}\n');
  await writeFile(b, '{}\n');
  await symlink(a, file);
  const plan = await planHook('claude', 'install', f.options);
  const retarget = { ...f.options, afterCommit: async () => { await rm(file); await symlink(b, file); } };
  await assert.rejects(applyHookPlan(plan, retarget), (error: Error) => error instanceof HookConflictError && /now points to another file than the one Fonn wrote/.test(error.message));
  assert.equal(await readFile(a, 'utf8'), plan.after);
  assert.equal(await readFile(b, 'utf8'), '{}\n');
  const c = path.join(f.root, 'dotfiles', 'c.json');
  await writeFile(c, '{}\n');
  const run = cli({ ...f.options, afterCommit: async () => { await rm(file); await symlink(c, file); } });
  assert.equal(await dispatch(['hooks', 'install', '--agent', 'claude', '--yes'], run.deps), 1);
  assert.doesNotMatch(run.out.join(''), /Claude Code: installed\./);
});

test('a failed temporary write leaves no temporary file and no change', async t => {
  const f = await hookFixture(t, 'enospc');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  await writeFile(file, '{}\n');
  const full = {
    ...f.options,
    writeTemporary: async (handle: import('node:fs/promises').FileHandle, content: string) => {
      await handle.writeFile(content.slice(0, 10));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    },
  };
  await assert.rejects(applyHookPlan(await planHook('claude', 'install', f.options), full), /ENOSPC/);
  assert.equal(await readFile(file, 'utf8'), '{}\n');
  assert.deepEqual((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp') || name.includes('fonn-lock')), []);
});

test('values are read as whole shell words at any quoting depth', () => {
  const cases = [
    `--command "sh -c \\"curl --token \\\\\\"deepSecret\\\\\\"\\""`,
    'API_KEY=foo\\\\barSecret',
    'curl -H "Authorization: Bearer \\"quotedSecret\\""',
    "Authorization: Bearer 'quoted bearerSecret'",
    `--token abc"def"'ghiSecret'`,
    `export GITHUB_TOKEN="part"'two'joinedSecret`,
  ];
  for (const text of cases) {
    const masked = maskSecrets(text);
    assert.doesNotMatch(masked, /Secret|abc|def|part|two|foo/, `${text} -> ${masked}`);
    assert.match(masked, /\[hidden\]/, text);
  }
  // Long input stays fast: the scan is linear.
  const started = Date.now();
  maskSecrets('--token ' + '"\\'.repeat(20000) + ' x=' + "'".repeat(20000));
  assert.ok(Date.now() - started < 1000);
});

test('only credential names are hidden, so benign flags stay visible', () => {
  for (const benign of ['--keymap vim', '--session-name work', '--auth-mode browser', 'KEYBOARD=us', 'monkey=banana', 'author: Ada']) {
    assert.equal(maskSecrets(benign), benign);
  }
  for (const name of ['GITHUB_TOKEN', 'client_secret', 'DB_PASSWORD', 'db-passwd', 'MYSQL_PWD', 'apiKey', 'OPENAI_API_KEY', 'x-api-key', 'AWS_ACCESS_KEY', 'private-key', 'auth_token', 'bearer', 'credentials', 'session_token', 'cookie']) {
    assert.equal(credentialName(name), true, name);
  }
  for (const name of ['keymap', 'session-name', 'auth-mode', 'apiKeyHelper', 'monkey']) assert.equal(credentialName(name), false, name);
  // The earlier secret cases stay hidden.
  const earlier = 'export DEBUG=1 OPENAI_API_KEY=jkl345\napi_key = "sk-2"\nprovider add x --api-key "sk-3"\ncurl -H \'X-Api-Key: def456\' -H "Authorization: Bearer abc123" https://user:pass789@h\n--token ghi012\nCookie: id=1\n';
  assert.doesNotMatch(redactForDisplay(earlier, 'crush')!, /jkl345|sk-2|sk-3|def456|abc123|pass789|ghi012|id=1/);
  const json = JSON.stringify({ env: { ANYTHING: 'v1' }, clientSecret: 'v2', keymap: 'vim', hooks: {} });
  const shown = redactForDisplay(json, 'claude')!;
  assert.doesNotMatch(shown, /v1|v2/);
  assert.match(shown, /"keymap": "vim"/);
});
