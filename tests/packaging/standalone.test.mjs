import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateStandalone } from '../../scripts/build-standalone-filter.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Allows verification of an unintegrated draft without writing to its source checkout.
const sourceRoot = process.env.FONN_STANDALONE_SOURCE_ROOT ?? root;

test('standalone downloads work without dependencies and preserve recovery, provider contracts and path confinement', async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'fonn-standalone-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, "download with ' quote");
  await generateStandalone({ root: sourceRoot, outputDirectory: directory });
  await cp(join(root, 'standalone/filtering/hook.mjs'), join(directory, 'hook.mjs'));
  const second = join(temporary, 'generated-again');
  await generateStandalone({ root: sourceRoot, outputDirectory: second });
  for (const name of ['index.mjs', 'adapters.mjs', 'artifact-store.mjs', 'LICENSE']) {
    assert.equal(await readFile(join(directory, name), 'utf8'), await readFile(join(second, name), 'utf8'));
    assert.equal(await readFile(join(directory, name), 'utf8'), await readFile(join(root, 'standalone/filtering', name), 'utf8'), `${name} must be regenerated after the core build`);
  }
  const external = join(temporary, 'external-output');
  await mkdir(external);
  await writeFile(join(external, 'sentinel'), 'DO NOT CHANGE');
  const outputLink = join(temporary, 'output-link');
  await symlink(external, outputLink);
  await assert.rejects(generateStandalone({ root: sourceRoot, outputDirectory: join(outputLink, 'nested') }), /physical directories/);
  assert.deepEqual(await readdir(external), ['sentinel']);
  const hostileOutput = join(temporary, 'hostile-output');
  await mkdir(hostileOutput);
  await symlink(join(external, 'sentinel'), join(hostileOutput, 'LICENSE'));
  await assert.rejects(generateStandalone({ root: sourceRoot, outputDirectory: hostileOutput }), /regular files/);
  assert.deepEqual(await readdir(hostileOutput), ['LICENSE']);
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'DO NOT CHANGE');
  const privateMarker = 'PRIVATE EXTERNAL SOURCE MUST NEVER BE COPIED';
  const privateSource = join(external, 'private-source');
  await writeFile(privateSource, privateMarker);
  for (const kind of ['source-file', 'source-parent', 'license', 'source-root']) {
    const fixtureRoot = join(temporary, `source-fixture-${kind}`);
    const fixtureModules = join(fixtureRoot, 'packages/core/dist/filtering');
    await mkdir(fixtureModules, { recursive: true });
    for (const name of ['index', 'adapters', 'artifact-store']) await cp(join(sourceRoot, `packages/core/dist/filtering/${name}.js`), join(fixtureModules, `${name}.js`));
    await cp(join(sourceRoot, 'LICENSE'), join(fixtureRoot, 'LICENSE'));
    let inputRoot = fixtureRoot;
    if (kind === 'source-file') {
      await rm(join(fixtureModules, 'index.js'));
      await symlink(privateSource, join(fixtureModules, 'index.js'));
    } else if (kind === 'source-parent') {
      await rm(fixtureModules, { recursive: true });
      await symlink(external, fixtureModules);
      await writeFile(join(external, 'index.js'), privateMarker);
    } else if (kind === 'license') {
      await rm(join(fixtureRoot, 'LICENSE'));
      await symlink(privateSource, join(fixtureRoot, 'LICENSE'));
    } else {
      inputRoot = join(temporary, 'symlink-source-root');
      await symlink(fixtureRoot, inputRoot);
    }
    const generated = join(temporary, `rejected-source-output-${kind}`);
    await assert.rejects(generateStandalone({ root: inputRoot, outputDirectory: generated }), /physical regular files/);
    await assert.rejects(lstat(generated), { code: 'ENOENT' });
    assert.equal(await readFile(privateSource, 'utf8'), privateMarker);
  }
  assert.deepEqual((await readdir(directory)).sort(), ['LICENSE', 'adapters.mjs', 'artifact-store.mjs', 'hook.mjs', 'index.mjs']);
  for (const name of ['index.mjs', 'adapters.mjs', 'artifact-store.mjs', 'hook.mjs']) {
    const code = await readFile(join(directory, name), 'utf8');
    assert(!/sourceMappingURL|data:|blob:|@anthropic|@openai|\brequire\s*\(/.test(code));
    for (const [, specifier] of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) assert(/^(?:node:|\.\/[a-z-]+\.mjs$)/.test(specifier));
  }
  const project = join(temporary, 'project');
  await mkdir(project);
  const script = join(directory, 'hook.mjs');
  const invoke = (args, input = '') => spawnSync(process.execPath, [script, ...args], { cwd: project, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', maxBuffer: 25 * 1024 * 1024, env: { PATH: process.env.PATH } });
  const help = invoke(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hook --provider claude\|codex/);
  assert.deepEqual(await readdir(project), []);
  const success = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const response = { stdout: `PHPUnit 12.0.0\n${'............................................................ 100 / 100 (100%)\n'.repeat(400)}WARNING: preserve this warning\nFAILURES!\nTests: 100, Assertions: 100, Failures: 1.\n`, stderr: 'private stderr retained\n', exitCode: 1, custom: { retained: true } };
  const event = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'vendor/bin/phpunit' }, tool_response: response, session_id: 'fixture-session', tool_use_id: 'fixture-tool', cwd: project };
  const hookArgs = (provider, mode, state) => ['hook', '--provider', provider, '--mode', mode, '--state-dir', state];
  let firstKey;
  for (const provider of ['claude', 'codex']) {
    const state = join(temporary, `${provider}-state`);
    const output = success(invoke(hookArgs(provider, 'filter', state), event));
    const filtered = provider === 'claude' ? output.hookSpecificOutput.updatedToolOutput : JSON.parse(output.stopReason);
    if (provider === 'claude') assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    else { assert.equal(output.continue, false); assert.deepEqual(Object.keys(output), ['continue', 'stopReason']); }
    assert.deepEqual({ ...filtered, stdout: response.stdout }, response);
    assert(filtered.stdout.length < response.stdout.length);
    assert(filtered.stdout.includes('WARNING: preserve this warning\nFAILURES!'));
    const [storeKey] = await readdir(state);
    assert.match(storeKey, /^[0-9a-f]{64}$/);
    if (firstKey) assert.notEqual(storeKey, firstKey);
    firstKey ??= storeKey;
    const [artifact] = await readdir(join(state, storeKey));
    const id = artifact.slice(0, -5);
    const serialized = JSON.stringify(response, null, 2);
    assert.equal(await readFile(join(state, storeKey, artifact), 'utf8'), serialized);
    assert.equal((await lstat(join(state, storeKey))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(state, storeKey, artifact))).mode & 0o777, 0o600);
    assert(filtered.stdout.includes(script.replaceAll("'", "'\\''")));
    assert(filtered.stdout.includes(state));
    const baseRead = ['read', storeKey, id, '--state-dir', state];
    const slice = success(invoke(baseRead));
    assert.equal(slice.text, serialized.slice(0, 4000));
    assert.equal(slice.nextOffset, 4000);
    assert.equal(slice.totalCharacters, serialized.length);
    const recoveryCommand = filtered.stdout.match(/; recover with (.+)\.\]\n$/)?.[1];
    assert(recoveryCommand);
    const recoveredViaFooter = spawnSync('/bin/sh', ['-c', recoveryCommand], { cwd: project, encoding: 'utf8' });
    assert.deepEqual(success(recoveredViaFooter), slice, 'the quoted footer command must run with apostrophes in the script path');
    let restored = '';
    let offset = 0;
    do {
      const part = success(invoke([...baseRead, '--offset', String(offset), '--limit', '20000']));
      restored += part.text;
      offset = part.nextOffset;
    } while (offset !== null);
    assert.equal(restored, serialized);
    for (const bounds of [['--limit', '20001'], ['--limit', '0'], ['--offset', '-1'], ['--offset', '1.5'], ['--offset', String(serialized.length + 1)], ['--limit', '4', '--limit', '5'], ['--unknown', '4']]) assert.notEqual(invoke([...baseRead, ...bounds]).status, 0);
    const observedState = join(temporary, `${provider}-observe`);
    assert.deepEqual(success(invoke(hookArgs(provider, 'observe', observedState), event)), {});
    const [observedKey] = await readdir(observedState);
    const [observedFile] = await readdir(join(observedState, observedKey));
    assert.equal(await readFile(join(observedState, observedKey, observedFile), 'utf8'), serialized);
    const offState = join(temporary, `${provider}-off`);
    assert.deepEqual(success(invoke(hookArgs(provider, 'off', offState), event)), {});
    await assert.rejects(lstat(offState), { code: 'ENOENT' });
    const heartbeat = Array.from({ length: 300 }, (_, i) => `PROGRESS worker=${i % 4} heartbeat=ok`).join('\n') + '\n';
    const similarState = join(temporary, `${provider}-similar`);
    const similar = success(invoke([...hookArgs(provider, 'filter', similarState), '--level', 'similar'], { ...event, tool_response: heartbeat }));
    assert.match(JSON.stringify(similar), /similar lines omitted; 298 lines between these differ only in numbers or IDs/);
    assert.notEqual(invoke([...hookArgs(provider, 'filter', similarState), '--level', 'loose'], event).status, 0);
    const untouched = join(temporary, `${provider}-untouched`);
    for (const other of [
      { ...event, tool_response: heartbeat },
      { ...event, tool_name: 'mcp__unknown__run' },
      { ...event, hook_event_name: 'PreToolUse' },
      { ...event, session_id: undefined }, { ...event, session_id: '' }, { ...event, session_id: 'invalid\n' },
      { ...event, cwd: undefined }, { ...event, cwd: 'relative-project' },
      { ...event, tool_response: { ...response, content: [{ type: 'text', text: response.stdout }] } },
    ]) assert.deepEqual(success(invoke(hookArgs(provider, 'filter', untouched), other)), {});
    await assert.rejects(lstat(untouched), { code: 'ENOENT' });
    const malformed = invoke(hookArgs(provider, 'filter', untouched), '{"secret":"do-not-log"');
    assert.deepEqual(success(malformed), {});
    assert(!malformed.stderr.includes('do-not-log'));
    const invalid = invoke(hookArgs(provider, 'filter', untouched), 'x'.repeat(10 * 1024 * 1024 + 1));
    assert.deepEqual(success(invalid), {});
    assert(!invalid.stderr.includes('do-not-log'));
    assert.notEqual(invoke([...hookArgs(provider, 'off', offState), '--mode', 'filter']).status, 0);
    for (const args of [['hook'], ['hook', '--provider', 'other', '--mode', 'filter'], ['hook', '--provider', provider, '--mode', 'other'], [...hookArgs(provider, 'off', offState), '--unknown', 'value'], ['read', storeKey, '../artifact', '--state-dir', state]]) assert.notEqual(invoke(args).status, 0);
    const outside = join(temporary, `${provider}-outside`);
    await mkdir(outside);
    await writeFile(join(outside, artifact), serialized);
    const hostileBase = join(temporary, `${provider}-base-link`);
    await symlink(outside, hostileBase);
    assert.deepEqual(success(invoke(hookArgs(provider, 'filter', join(hostileBase, 'nested')), event)), {});
    assert.deepEqual(await readdir(outside), [artifact]);
    const hostileNamespace = join(temporary, `${provider}-namespace-state`);
    await mkdir(hostileNamespace);
    await symlink(outside, join(hostileNamespace, storeKey));
    assert.deepEqual(success(invoke(hookArgs(provider, 'filter', hostileNamespace), event)), {});
    assert.notEqual(invoke(['read', storeKey, id, '--state-dir', hostileNamespace]).status, 0);
    assert.notEqual(invoke(['read', storeKey, id, '--state-dir', hostileBase]).status, 0);
    await rm(join(state, storeKey, artifact));
    await symlink(join(outside, artifact), join(state, storeKey, artifact));
    assert.notEqual(invoke(baseRead).status, 0);
    assert.notEqual(invoke(['read', '../outside', id, '--state-dir', state]).status, 0);
  }
});
