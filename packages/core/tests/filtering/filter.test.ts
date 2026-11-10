import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ArtifactStore, FilterDecision, ToolObservation } from '../../src/contracts.js';
import { createArtifactStore, createOutputFilter } from '../../src/filtering/index.js';

async function fixture(name: string) { return readFile(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8'); }
async function store() { return createArtifactStore(await mkdtemp(join(tmpdir(), 'fonn-filter-test-'))); }
function observation(command: string, response: unknown): ToolObservation {
  return { toolName: 'Bash', toolInput: { command }, response, sessionId: 's', toolUseId: 't', cwd: '/project' };
}
async function filter() { return createOutputFilter({ store: await store(), mode: 'filter', minimumCharacters: 0, minimumSavingsCharacters: 0 }); }

test('PHPUnit failure keeps all diagnostics and full recoverable response while removing pure-dot progress', async () => {
  const archive = await store();
  const stdout = await fixture('phpunit-failure');
  const response = { stdout, stderr: 'PHP Warning: sensitive warning', interrupted: false, isImage: false, exitCode: 1, metadata: { token: 'retain' } };
  const events: FilterDecision[] = [];
  const result = await createOutputFilter({ store: archive, mode: 'filter', minimumCharacters: 0, minimumSavingsCharacters: 0, onDecision: d => events.push(d) }).apply(observation('vendor/bin/phpunit', response));
  assert.equal(result.decision.status, 'filtered');
  assert.equal(result.decision.adapter, 'phpunit');
  assert.equal(result.decision.removedLines, 5);
  const delivered = result.response as typeof response;
  assert.equal(delivered.stderr, response.stderr);
  assert.equal(delivered.exitCode, 1);
  assert.equal(delivered.metadata, response.metadata);
  assert.match(delivered.stdout, /Failed asserting that 200 is identical to 422/);
  assert.match(delivered.stdout, /BookingTest.php:41/);
  assert.match(delivered.stdout, /FAILURES!/);
  assert.match(delivered.stdout, /mcp__fonn__read_output/);
  assert.match(delivered.stdout, new RegExp(result.decision.artifactId!));
  assert.deepEqual(JSON.parse((await archive.read(result.decision.artifactId!)).text), response);
  assert.equal(events.length, 1);
  assert.equal(result.decision.deliveredCharacters, delivered.stdout.length);
  assert.equal(result.decision.proposedCharacters, delivered.stdout.length);
});

test('Pest and PHPStan fixtures preserve summaries, errors and unknown lines', async () => {
  for (const [command, name, adapter] of [['php artisan test', 'pest-success', 'pest'], ['vendor/bin/phpstan analyse', 'phpstan-error', 'phpstan']]) {
    const text = await fixture(name);
    const result = await (await filter()).apply(observation(command, { stdout: text + '\nunknown context: keep this\n' }));
    assert.equal(result.decision.status, 'filtered');
    assert.equal(result.decision.adapter, adapter);
    const stdout = (result.response as { stdout: string }).stdout;
    assert.match(stdout, /unknown context: keep this/);
    if (adapter === 'phpstan') {
      assert.match(stdout, /should return Booking/);
      assert.match(stdout, /but returns null/);
      assert.match(stdout, /Found 1 error/);
    } else assert.match(stdout, /315 passed \(780 assertions\)/);
  }
});

test('TypeScript only coalesces adjacent byte-identical diagnostic blocks and retains multiplicity', async () => {
  const text = await fixture('tsc-errors');
  const result = await (await filter()).apply(observation('npx tsc --noEmit', text));
  assert.equal(result.decision.status, 'filtered');
  assert.equal(result.decision.adapter, 'tsc');
  assert.equal((result.response as string).match(/error TS2322/g)?.length, 1);
  assert.match(result.response as string, /identical diagnostic occurred 4 times/);
  assert.match(result.response as string, /error TS2304/);
  const distinct = 'src/a.ts(1,1): error TS1000: same\nsrc/b.ts(1,1): error TS1000: same\n';
  const unchanged = await (await filter()).apply(observation('tsc', distinct));
  assert.equal(unchanged.response, distinct);
  const separated = text.split('\n')[0] + '\nother context\n' + text.split('\n')[0] + '\n';
  assert.equal((await (await filter()).apply(observation('tsc', separated))).response, separated);
  const multiline = "src/a.ts(1,1): error TS2322: Type 'Promise<Booking | null>' is not assignable to type 'Promise<Booking>'.\n  Type 'Booking | null' is not assignable to type 'Booking'.\n    Type 'null' is not assignable to type 'Booking'.\n";
  const folded = await (await filter()).apply(observation('tsc --noEmit', multiline.repeat(4)));
  assert.equal(folded.decision.status, 'filtered');
  assert.ok((folded.response as string).includes(multiline));
  assert.match(folded.response as string, /identical diagnostic occurred 4 times/);
});

test('warnings and mixed progress markers are preserved verbatim', async () => {
  const mixed = '.W.S.R.F.E....................................................... 126 / 315 ( 40%)\n';
  const warning = 'There was 1 PHPUnit test runner warning:\n1) No code coverage driver available\n';
  const text = (await fixture('phpunit-failure')) + mixed + warning;
  const result = await (await filter()).apply(observation('./vendor/bin/phpunit', text));
  assert.equal(result.decision.status, 'filtered');
  assert.ok((result.response as string).includes(mixed));
  assert.ok((result.response as string).includes(warning));
});

test('unknown commands, wrappers, formats, source/diff and cursor output remain identical', async () => {
  const text = await fixture('phpunit-failure');
  for (const command of ['cat output.txt', 'echo phpunit', 'vendor/bin/phpunit; cat secret', 'vendor/bin/phpunit | cat', 'cd /app && vendor/bin/phpunit', 'sh -c "vendor/bin/phpunit"']) {
    const result = await (await filter()).apply(observation(command, text));
    assert.equal(result.response, text);
    assert.equal(result.decision.status, 'unchanged');
  }
  for (const value of ['diff --git a/a.ts b/a.ts\n+some source\n', Array.from({ length: 100 }, (_, i) => `unrecognized output ${i}\n`).join(''), '\u001b[31m' + text, text.replace(/\n/g, '\r')]) {
    assert.equal((await (await filter()).apply(observation('vendor/bin/phpunit', value))).response, value);
  }
});

test('off skips all work; observe archives proposal and delivers original; filtered output is idempotent', async () => {
  const archive = await store();
  let saves = 0;
  const counting: ArtifactStore = { save: async input => { saves++; return archive.save(input); }, read: archive.read };
  const response = { stdout: await fixture('phpunit-failure'), stderr: 'warning' };
  const input = observation('vendor/bin/phpunit', response);
  const off = await createOutputFilter({ store: counting, mode: 'off' }).apply(input);
  assert.equal(off.response, response);
  assert.equal(saves, 0);
  const options = { store: counting, minimumCharacters: 0, minimumSavingsCharacters: 0 };
  const observed = await createOutputFilter({ ...options, mode: 'observe' }).apply(input);
  assert.equal(observed.response, response);
  assert.equal(observed.decision.status, 'observed');
  assert.ok(observed.decision.proposedCharacters < observed.decision.deliveredCharacters);
  assert.equal(saves, 1);
  const filtered = await createOutputFilter({ ...options, mode: 'filter' }).apply(input);
  const again = await createOutputFilter({ ...options, mode: 'filter' }).apply({ ...input, response: filtered.response });
  assert.equal(again.response, filtered.response);
  assert.equal(again.decision.reason, 'already_filtered');
  assert.equal(saves, 2);
});

test('image, interrupted and structured content results are never rewritten', async () => {
  for (const extra of [{ isImage: true }, { interrupted: true }, { type: 'image' }, { content: [{ type: 'image', data: 'unchanged' }] }]) {
    const response = { stdout: await fixture('phpunit-failure'), ...extra };
    const result = await (await filter()).apply(observation('vendor/bin/phpunit', response));
    assert.equal(result.response, response);
    assert.equal(result.decision.status, 'unchanged');
  }
});

test('archive failure, invalid archive id and serialization failure fail open without leaked error metadata', async () => {
  const text = await fixture('phpunit-failure');
  for (const failing of [
    { save: async () => { throw new Error('command: secret-token'); }, read: async () => { throw new Error(); } },
    { save: async () => ({ id: '../../secret', characters: 1, createdAt: '' }), read: async () => { throw new Error(); } },
  ] satisfies ArtifactStore[]) {
    const result = await createOutputFilter({ store: failing, mode: 'filter', minimumCharacters: 0, minimumSavingsCharacters: 0 }).apply(observation('vendor/bin/phpunit --token=secret-token', { stdout: text }));
    assert.equal((result.response as { stdout: string }).stdout, text);
    assert.equal(result.decision.reason, 'archive_or_parse_failed');
    assert.ok(!JSON.stringify(result.decision).includes('secret-token'));
  }
  const response: Record<string, unknown> = { stdout: text };
  response.self = response;
  const result = await (await filter()).apply(observation('vendor/bin/phpunit', response));
  assert.equal(result.response, response);
  assert.equal(result.decision.status, 'unchanged');
});

test('default thresholds and footer overhead prevent small or unhelpful changes', async () => {
  const stdout = await fixture('phpunit-failure');
  const defaults = createOutputFilter({ store: await store(), mode: 'filter' });
  const small = await defaults.apply(observation('vendor/bin/phpunit', stdout));
  assert.equal(small.response, stdout);
  assert.equal(small.decision.reason, 'below_minimum_characters');
  const long = stdout.replace(/^\.+[^\n]*\n/gm, line => line.repeat(10));
  const reduced = await defaults.apply(observation('vendor/bin/phpunit', long));
  assert.equal(reduced.decision.status, 'filtered');
  assert.ok(reduced.decision.originalCharacters - reduced.decision.deliveredCharacters >= 256);
  const costly = await createOutputFilter({ store: await store(), mode: 'filter', minimumCharacters: 0, minimumSavingsCharacters: 10_000 }).apply(observation('vendor/bin/phpunit', long));
  assert.equal(costly.response, long);
  assert.equal(costly.decision.reason, 'below_minimum_savings');
});

test('a throwing metrics callback cannot corrupt delivery', async () => {
  const result = await createOutputFilter({ store: await store(), mode: 'off', onDecision() { throw new Error('metrics'); } }).apply(observation('tsc', 'hello'));
  assert.equal(result.response, 'hello');
});

test('custom recovery hints use the archived ID and throwing hints fail open', async () => {
  const response = await fixture('phpunit-failure');
  const filterOptions = { store: await store(), mode: 'filter' as const, minimumCharacters: 0, minimumSavingsCharacters: 0 };
  const result = await createOutputFilter({ ...filterOptions, recoveryHint: id => `fonn output ${id}` }).apply(observation('vendor/bin/phpunit', response));
  assert.equal(result.decision.status, 'filtered');
  assert.ok((result.response as string).includes(`fonn output ${result.decision.artifactId}`));
  assert.ok(!(result.response as string).includes('mcp__fonn__read_output'));
  const failed = await createOutputFilter({ ...filterOptions, recoveryHint() { throw new Error('failed'); } }).apply(observation('vendor/bin/phpunit', response));
  assert.equal(failed.response, response);
  assert.equal(failed.decision.status, 'unchanged');
});

test('levels: strict keeps adapters only, standard collapses identical lines, similar keeps problem lines', async () => {
  const heartbeat = Array.from({ length: 40 }, (_, i) => `PROGRESS worker=${i % 4} status=healthy heartbeat=ok`);
  const text = ['start', ...Array(30).fill('waiting for lock'), 'ok', 'ok', ...heartbeat, 'ERROR worker=2 lost', 'ERROR worker=3 lost', 'done', ''].join('\n');
  const command = 'node scripts/worker.js | tee log.txt';

  const generic = await (await filter()).apply(observation(command, text));
  assert.equal(generic.decision.adapter, 'repeated-lines');
  assert.equal(generic.decision.removedLines, 29);
  assert.match(generic.response as string, /^start\nwaiting for lock\n\[fonn: identical line occurred 30 times; 29 duplicate copies archived\]\nok\nok\nPROGRESS worker=0/);
  assert.match(generic.response as string, /PROGRESS worker=3 status=healthy heartbeat=ok\nERROR worker=2 lost\nERROR worker=3 lost\ndone\n/);

  const strict = await createOutputFilter({ store: await store(), mode: 'filter', level: 'strict', minimumCharacters: 0, minimumSavingsCharacters: 0 }).apply(observation(command, text));
  assert.equal(strict.response, text);
  assert.equal(strict.decision.reason, 'unrecognized_format');

  const similar = await createOutputFilter({ store: await store(), mode: 'filter', level: 'similar', minimumCharacters: 0, minimumSavingsCharacters: 0 }).apply(observation(command, text));
  assert.equal(similar.decision.adapter, 'similar-lines');
  assert.equal(similar.decision.removedLines, 29 + 38);
  const lines = (similar.response as string).split('\n');
  assert.deepEqual(lines.slice(0, 7), ['start', 'waiting for lock', '[fonn: identical line occurred 30 times; 29 duplicate copies archived]', 'ok', 'ok', heartbeat[0], '[fonn: similar lines omitted; 38 lines between these differ only in numbers or IDs; originals archived]']);
  assert.deepEqual(lines.slice(7, 11), [heartbeat[39], 'ERROR worker=2 lost', 'ERROR worker=3 lost', 'done']);

  // Already reduced output is never reduced again.
  const again = await createOutputFilter({ store: await store(), mode: 'filter', level: 'similar', minimumCharacters: 0, minimumSavingsCharacters: 0 }).apply(observation(command, similar.response));
  assert.equal(again.decision.reason, 'already_filtered');
});

test('pytest, Jest and Vitest drop only certain passes once the runner summary is present', async () => {
  const cases = [
    { fixture: 'pytest-failure', commands: ['pytest', 'python -m pytest', '.venv/bin/pytest'], adapter: 'pytest', removed: 6,
      kept: ['tests/test_billing.py ....................F', 'tests/test_utils.py ..........s', 'E       assert 20 == 0', 'DeprecationWarning', 'FAILED tests/test_billing.py::test_zero_limit', '1 failed, 410 passed, 1 skipped, 1 warning'] },
    { fixture: 'jest-failure', commands: ['npx jest', 'npm test', 'pnpm run test'], adapter: 'jest', removed: 33,
      kept: ['FAIL src/billing/limit.test.ts', '✕ keeps zero', '○ skipped handles negative values', 'Received: 20', 'console.warn', 'Tests:       1 failed, 1 skipped, 286 passed, 288 total'] },
    { fixture: 'vitest-failure', commands: ['npx vitest run', 'yarn test'], adapter: 'vitest', removed: 31,
      kept: ['❯ src/billing/limit.test.ts (3 tests | 1 failed)', '× resolveLimit > keeps zero', '↓ resolveLimit > handles negative values', '+ 20', 'Tests  1 failed | 1 skipped | 286 passed (288)'] },
  ];
  for (const { fixture: name, commands, adapter, removed, kept } of cases) {
    const text = await fixture(name);
    for (const command of commands) {
      const result = await (await filter()).apply(observation(command, text));
      assert.equal(result.decision.adapter, adapter, `${name} via ${command}`);
      assert.equal(result.decision.removedLines, removed, `${name} via ${command}`);
      for (const line of kept) assert.ok((result.response as string).includes(line), `${name} kept ${line}`);
    }
    // Without the runner's own summary nothing is removed by the adapter.
    const truncated = text.split('\n').filter((line) => !/^(?:Test Suites:|\s*Test Files|=+ test session starts)/.test(line)).join('\n');
    const result = await createOutputFilter({ store: await store(), mode: 'filter', level: 'strict', minimumCharacters: 0, minimumSavingsCharacters: 0 }).apply(observation(commands[0]!, truncated));
    assert.equal(result.response, truncated, `${name} without summary`);
  }
});

test('user rules remove matching lines for matching commands, never problem lines', async () => {
  const { filterRulesSchema } = await import('../../src/settings.js');
  const rules = [{ name: 'db wait', command: 'npm run dev', remove: ['Waiting for database'] }];
  const lines = ['> app dev', ...Array.from({ length: 40 }, (_, i) => `Waiting for database (attempt ${i})`), 'Waiting for database failed: connection refused', 'Waiting for database: 2 high severity vulnerabilities', 'Server ready', ''];
  const text = lines.join('\n');
  const run = (command: string, level?: 'strict' | 'standard') => createOutputFilter({ store: { save: async () => ({ id: '3f6c1d2e-8a4b-4c1d-9e2f-5a6b7c8d9e0f' }), read: async () => { throw new Error('unused'); } } as unknown as ArtifactStore, mode: 'filter', level, rules, minimumCharacters: 0, minimumSavingsCharacters: 0 }).apply(observation(command, text));

  const result = await run('npm run dev -- --port 3000', 'strict');
  const output = result.response as string;
  assert.equal(result.decision.status, 'filtered');
  assert.equal(result.decision.removedLines, 40);
  assert.match(output, /\[fonn: lines removed by rule "db wait": 40; originals archived\]/);
  // The failure line contains the rule text but mentions a problem, so it stays.
  assert.match(output, /Waiting for database failed: connection refused/);
  // Rules can come from other people's files, so security lines stay too.
  assert.match(output, /2 high severity vulnerabilities/);

  // Problem lines the generic pattern misses are protected from rules as well.
  const tool = ['npm ERR! code ELIFECYCLE', 'not ok 1 - adds numbers', 'Error: listen EADDRINUSE :::3000', '✖ adds numbers', 'Process exited with code 1', 'ok 2 - subtracts'];
  const npmRule = createOutputFilter({ store: { save: async () => ({ id: '3f6c1d2e-8a4b-4c1d-9e2f-5a6b7c8d9e0f' }), read: async () => { throw new Error('unused'); } } as unknown as ArtifactStore, mode: 'filter', level: 'strict', rules: [{ name: 'all', command: 'npm', remove: ['npm', 'ok ', 'adds', 'EADDRINUSE', 'exited', 'subtracts'] }], minimumCharacters: 0, minimumSavingsCharacters: 0 });
  const kept = (await npmRule.apply(observation('npm test', [...tool, ...Array.from({ length: 30 }, (_, i) => `ok ${i + 3} - subtracts`), ''].join('\n')))).response as string;
  for (const line of tool.slice(0, 5)) assert.ok(kept.includes(line), line);
  assert.match(output, /Server ready/);

  // A command that only shares a prefix with the rule is untouched by it.
  assert.notEqual((await run('npm run devtools')).decision.adapter?.startsWith('rule:'), true);

  // Rules are plain text with limits; anything else is rejected.
  assert.equal(filterRulesSchema.safeParse([{ name: 'x', command: 'npm', remove: ['ab'] }]).success, false);
  assert.equal(filterRulesSchema.safeParse([{ name: 'x', command: 'npm\nrm', remove: ['abc'] }]).success, false);
  assert.equal(filterRulesSchema.safeParse([{ name: 'x', command: 'npm', remove: ['abc'] }, { name: 'x', command: 'yarn', remove: ['abc'] }]).success, false);
  assert.equal(filterRulesSchema.safeParse([{ name: 'x', command: 'npm', remove: ['abc'], regex: '.*' }]).success, false);
});
