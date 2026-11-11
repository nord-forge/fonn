import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyHookPlan, HookConflictError, planHook, redactForDisplay } from '../../src/hooks/index.js';
import { maskSecrets } from '../../src/hooks/redact.js';
import { hookFixture } from './fixture.js';

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const leftovers = async (folder: string) => (await readdir(folder)).filter(name => name.endsWith('.tmp') || name.includes('fonn-lock'));

test('a save by another program right after Fonn writes is kept, and Fonn reports it instead of success', async t => {
  const f = await hookFixture(t, 'after-write');
  const file = path.join(f.home, '.claude', 'settings.json');
  await mkdir(path.dirname(file));
  const original = '{\n  "model": "opus"\n}\n';
  await writeFile(file, original);
  const plan = await planHook('claude', 'install', f.options);
  const newer = '{"model": "sonnet"}\n';
  const edit = { ...f.options, afterCommit: async () => { await writeFile(file, newer); } };
  await assert.rejects(applyHookPlan(plan, edit), (error: Error) => error instanceof HookConflictError
    && error.message === `${file} was saved by another program right after Fonn wrote it. Fonn kept that version, so its change may be missing. Run the command again to check.`);
  // The other program's save is the newest and is never overwritten.
  assert.equal(await readFile(file, 'utf8'), newer);
  assert.notEqual(original, newer);
  assert.deepEqual(await leftovers(path.dirname(file)), []);

  // The same holds for a file Fonn created: the other program's version stays.
  const created = await hookFixture(t, 'after-create');
  const codex = path.join(created.home, '.codex', 'hooks.json');
  await assert.rejects(applyHookPlan(await planHook('codex', 'install', created.options), { ...created.options, afterCommit: async () => { await writeFile(codex, '{}'); } }), HookConflictError);
  assert.equal(await readFile(codex, 'utf8'), '{}');

  // Normal writes are unaffected and leave nothing behind.
  const status = await applyHookPlan(await planHook('claude', 'install', f.options), f.options);
  assert.equal(status.current, true);
  assert.deepEqual(await leftovers(path.dirname(file)), []);
});

test('secrets nested inside benign quoted values are masked, and plain text is unchanged', () => {
  assert.equal(maskSecrets('--command "curl --token syntheticSecret"'), '--command "curl --token [hidden]"');
  assert.equal(maskSecrets('DEBUG="API_KEY=syntheticSecret"'), 'DEBUG="API_KEY=[hidden]"');
  const doubly = maskSecrets(`--command "sh -c 'FOO=\\"PASSWORD=syntheticSecret\\" curl --api-key=otherSecret'"`);
  assert.doesNotMatch(doubly, /syntheticSecret|otherSecret/);
  assert.match(doubly, /PASSWORD=\[hidden\]/);
  assert.match(doubly, /--api-key=\[hidden\]/);
  const escaped = maskSecrets('--command "curl --token \\"syntheticSecret\\" -H \\"Authorization: Bearer abc\\""');
  assert.doesNotMatch(escaped, /syntheticSecret|abc/);
  for (const plain of ['echo hello --verbose DEBUG=1 https://example.com/path "quoted words"', 'hook add PostToolUse --name fonn --matcher \'^bash$\' --command "\'/usr/bin/node\' \'/x/packages/cli/dist/cli/main.js\' \'hook\' \'--agent\' \'crush\'" --timeout 5', 'model = "gpt-6.1-sol"', '']) {
    assert.equal(maskSecrets(plain), plain);
  }
  const json = JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'run --command "curl --token syntheticSecret"' }] }] } });
  assert.doesNotMatch(redactForDisplay(json, 'claude')!, /syntheticSecret/);
  assert.doesNotMatch(redactForDisplay('DEBUG="API_KEY=syntheticSecret"\n', 'crush')!, /syntheticSecret/);
});

test('previews hide secrets past the quoting depth and under secret header keys', async () => {
  const { redactForDisplay } = await import('../../src/hooks/redact.js');
  // Seven nested sh -c layers: past the scanning depth, contents are hidden rather than shown unread.
  let deep = 'curl --token syntheticDeepSecret';
  for (let level = 0; level < 7; level++) deep = `sh -c ${JSON.stringify(deep)}`;
  assert.doesNotMatch(maskSecrets(deep), /syntheticDeepSecret/);
  const json = JSON.stringify({ hooks: { headers: { Authorization: 'Bearer syntheticAuthSecret', 'X-Api-Key': 'syntheticKey' }, mode: 'browser' } }, null, 2);
  const shown = redactForDisplay(json, 'claude') ?? '';
  assert.doesNotMatch(shown, /syntheticAuthSecret|syntheticKey/);
  assert.match(shown, /"mode": "browser"/, 'ordinary values stay visible');
});

test('a hook from a source checkout says it follows that folder\'s current build', async t => {
  const f = await hookFixture(t, 'checkout');
  const { hookStatus } = await import('../../src/hooks/index.js');
  const { applyHookPlan: apply } = await import('../../src/hooks/index.js');
  // Without a Git folder above the entrypoint there is no note.
  const plain = await planHook('claude', 'install', f.options);
  assert.ok(plain.summary.every(line => !/source checkout/.test(line)));
  // The fixture's install folder becomes a Git working folder.
  await mkdir(path.join(f.main, '..', '..', '..', '..', '..', '.git'));
  const plan = await planHook('claude', 'install', f.options);
  assert.ok(plan.summary.some(line => /runs the current build of the source checkout/.test(line)), 'the install plan warns');
  await apply(plan, f.options);
  const claude = (await hookStatus(f.options)).find(status => status.agent === 'claude')!;
  assert.match(claude.note ?? '', /install it from a copy that stays on a release or on main/);
});
