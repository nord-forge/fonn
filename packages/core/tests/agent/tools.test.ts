import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createToolRunner } from '../../src/agent/index.js';
import type { AgentHost, ApprovalDecision, ApprovalRequest, ToolRunnerOptions } from '../../src/agent/index.js';

async function setup(decide: (request: ApprovalRequest) => ApprovalDecision = () => ({ allow: true }), extra: Partial<ToolRunnerOptions> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'fonn-agent-tools-')));
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const approvals: ApprovalRequest[] = [];
  const host: AgentHost = { async approve(request) { approvals.push(request); return decide(request); }, onEvent() {} };
  const runner = createToolRunner({
    root, host, stateDirectory: join(base, 'state'), sessionId: 'session',
    filterMode: 'filter', filterLevel: 'standard', filterRules: [], ...extra,
  });
  let counter = 0;
  const call = (name: string, args: unknown) => runner.run({ id: `call_${++counter}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
  return { base, root, outside, approvals, runner, call };
}

test('reads inside the root without approval and asks for a symlink that leaves it', async () => {
  const { root, outside, approvals, call } = await setup();
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
  const inside = await call('read_file', { path: 'a.txt', offset_line: 2, max_lines: 1 });
  assert.equal(inside.ok, true);
  assert.equal(inside.content, 'a.txt: lines 2-2 of 3\ntwo\n[more lines follow; continue with offset_line 3]');
  assert.equal(approvals.length, 0);
  const linked = await call('read_file', { path: 'link.txt' });
  assert.equal(linked.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.kind, 'read');
  assert.equal(approvals[0]!.target, join(outside, 'secret.txt'));
  assert.match(approvals[0]!.summary, /through a link/);
  const listed = await call('list_files', {});
  assert.equal(listed.content, '.:\na.txt\nlink.txt@');
  assert.equal(approvals.length, 1);
});

test('a declined outside read tells the model the reason', async () => {
  const { outside, call } = await setup(() => ({ allow: false, reason: 'private folder' }));
  await writeFile(join(outside, 'x.txt'), 'x');
  const result = await call('read_file', { path: join(outside, 'x.txt') });
  assert.equal(result.ok, false);
  assert.equal(result.content, 'The user declined this read. Their reason: private folder');
});

test('edit_file needs old_text exactly once and shows a diff for approval', async () => {
  const { root, approvals, call } = await setup();
  await writeFile(join(root, 'app.ts'), 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
  const missing = await call('edit_file', { path: 'app.ts', old_text: 'const c', new_text: 'x' });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /old_text was not found in app\.ts/);
  const twice = await call('edit_file', { path: 'app.ts', old_text: '= 1;', new_text: '= 3;' });
  assert.equal(twice.ok, false);
  assert.match(twice.content, /occurs 2 times/);
  assert.equal(approvals.length, 0);
  const edited = await call('edit_file', { path: 'app.ts', old_text: 'const b = 2;', new_text: 'const b = 20;' });
  assert.equal(edited.ok, true);
  assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'const a = 1;\nconst b = 20;\nconst a2 = 1;\n');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.kind, 'edit');
  assert.equal(approvals[0]!.target, join(root, 'app.ts'));
  assert.equal(approvals[0]!.detail, '--- a/app.ts\n+++ b/app.ts\n@@ -1,4 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 20;\n const a2 = 1;\n ');
});

test('write_file always asks and a denial is reported without writing', async () => {
  const { root, approvals, call } = await setup(() => ({ allow: false }));
  const result = await call('write_file', { path: 'new.txt', content: 'a\nb\n' });
  assert.equal(result.ok, false);
  assert.equal(result.content, 'The user declined this change. They gave no reason.');
  assert.equal(approvals[0]!.kind, 'write');
  assert.equal(approvals[0]!.summary, 'Create new.txt (2 lines)');
  assert.equal(approvals[0]!.detail, 'a\nb\n');
  await assert.rejects(readFile(join(root, 'new.txt')));
});

test('remember covers only the exact command text or the exact file path', async () => {
  const { root, approvals, call } = await setup(() => ({ allow: true, remember: true }));
  await call('run_command', { command: 'echo one' });
  await call('run_command', { command: 'echo one' });
  await call('run_command', { command: 'echo  one' });
  assert.deepEqual(approvals.map((request) => request.target), ['echo one', 'echo  one']);
  await call('write_file', { path: 'a.txt', content: 'x' });
  await call('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' });
  await call('write_file', { path: './a.txt', content: 'z' });
  await call('write_file', { path: 'b.txt', content: 'z' });
  assert.deepEqual(approvals.slice(2).map((request) => request.target), [join(root, 'a.txt'), join(root, 'b.txt')]);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'z');
});

test('command output goes through the filter, is archived and read back in bounded slices', async () => {
  const { approvals, call } = await setup();
  const result = await call('run_command', { command: 'for i in $(seq 1 3000); do echo "same line of output"; done; echo done >&2; exit 3' });
  assert.equal(approvals[0]!.kind, 'command');
  assert.equal(result.ok, false);
  assert.equal(result.filter?.status, 'filtered');
  assert.ok(result.filter!.removedLines > 2_000);
  assert.ok(result.filter!.deliveredCharacters < result.filter!.originalCharacters);
  assert.match(result.content, /done\n/);
  assert.match(result.content, /exit code 3$/);
  assert.doesNotMatch(result.content, /recover with/);
  const id = /Call read_original with \{"id":"([0-9a-f-]{36})"\}/.exec(result.content)?.[1];
  assert.ok(id);
  const first = await call('read_original', { id });
  assert.equal(first.ok, true);
  assert.match(first.content, /characters 0-20000 of \d+/);
  assert.match(first.content, /call read_original with offset 20000/);
  const next = await call('read_original', { id, offset: 20_000 });
  assert.match(next.content, /characters 20000-/);
  const unknown = await call('read_original', { id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(unknown.ok, false);
  const invalid = await call('read_original', { id: '../../etc/passwd' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.content, /invalid arguments/);
});

test('a command that runs too long is killed with its process group', async () => {
  const { call } = await setup(undefined, { commandTimeoutMs: 300 });
  const started = Date.now();
  const result = await call('run_command', { command: 'sleep 5 & sleep 5; echo never' });
  assert.ok(Date.now() - started < 4_000);
  assert.equal(result.ok, false);
  assert.match(result.content, /timed out after 0.3 seconds; the command was stopped$/);
  assert.doesNotMatch(result.content, /never/);
});

test('unknown tools and invalid JSON return errors for the model', async () => {
  const { call } = await setup();
  assert.match((await call('delete_everything', {})).content, /unknown tool "delete_everything"/);
  assert.match((await call('read_file', '{"path": ')).content, /not valid JSON/);
  assert.match((await call('read_file', { path: 'a', extra: true })).content, /invalid arguments for read_file/);
});
