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
  for (const value of ['diff --git a/a.ts b/a.ts\n+some source\n', 'unrecognized output\n'.repeat(100), '\u001b[31m' + text, text.replace(/\n/g, '\r')]) {
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
