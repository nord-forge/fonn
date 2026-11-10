import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
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

test('crush and opencode hooks take and return plain text, keep problem lines and fail open', async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'fonn-standalone-text-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'scripts');
  await mkdir(directory);
  for (const name of ['hook.mjs', 'index.mjs', 'adapters.mjs', 'artifact-store.mjs', 'opencode-plugin.js']) await cp(join(root, 'standalone/filtering', name), join(directory, name));
  const project = join(temporary, 'project');
  await mkdir(project);
  const script = join(directory, 'hook.mjs');
  const invoke = (args, input) => spawnSync(process.execPath, [script, ...args], { cwd: project, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH } });
  const success = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const text = `PHPUnit 12.0.0\n${'............................................................ 100 / 100 (100%)\n'.repeat(400)}WARNING: preserve this warning\nFAILURES!\nTests: 100, Assertions: 100, Failures: 1.\nExit code 1`;
  const event = { event: 'PostToolUse', hook_event_name: 'PostToolUse', session_id: 'fixture-session', cwd: project, tool_name: 'bash', tool_input: { command: 'vendor/bin/phpunit' }, tool_use_id: 'call_01', tool_response: text };
  const hookArgs = (provider, state) => ['hook', '--provider', provider, '--mode', 'filter', '--state-dir', state];
  const keys = [];
  for (const provider of ['crush', 'opencode']) {
    const state = join(temporary, `${provider}-state`);
    const output = success(invoke(hookArgs(provider, state), event));
    assert.deepEqual(Object.keys(output), ['updated_output']);
    const filtered = output.updated_output;
    assert.equal(typeof filtered, 'string');
    assert(filtered.length < text.length);
    assert(filtered.includes('WARNING: preserve this warning\nFAILURES!\nTests: 100, Assertions: 100, Failures: 1.\nExit code 1'));
    const [storeKey] = await readdir(state);
    keys.push(storeKey);
    const recoveryCommand = filtered.match(/; recover with (.+)\.\]\n$/)?.[1];
    assert(recoveryCommand);
    let restored = '';
    let offset = 0;
    do {
      const part = success(spawnSync('/bin/sh', ['-c', `${recoveryCommand} --offset ${offset} --limit 20000`], { cwd: project, encoding: 'utf8' }));
      restored += part.text;
      offset = part.nextOffset;
    } while (offset !== null);
    assert.equal(JSON.parse(restored), text);
    assert.equal(success(invoke(hookArgs(provider, state), { ...event, tool_name: 'BASH' })).updated_output.length, filtered.length);
    const untouched = join(temporary, `${provider}-untouched`);
    for (const other of [
      { ...event, tool_response: 'short output\n' },
      { ...event, tool_response: { stdout: text } },
      { ...event, tool_name: 'view' },
      { ...event, hook_event_name: 'PostToolUseFailure' },
      { ...event, session_id: '' }, { ...event, cwd: 'relative' },
    ]) assert.deepEqual(success(invoke(hookArgs(provider, untouched), other)), {});
    await assert.rejects(lstat(untouched), { code: 'ENOENT' });
    const malformed = invoke(hookArgs(provider, untouched), '{"secret":"do-not-log"');
    assert.deepEqual(success(malformed), {});
    assert(!malformed.stderr.includes('do-not-log'));
  }
  assert.notEqual(keys[0], keys[1]);
  // The lowercase tool name and string response stay specific to the text providers.
  assert.deepEqual(success(invoke(hookArgs('claude', join(temporary, 'claude-state')), event)), {});

  const { FonnFilter } = await import(pathToFileURL(join(directory, 'opencode-plugin.js')).href);
  const fakeChild = (stdout, { code = 0, close = true } = {}) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end(input) {
        child.input = input;
        if (close) setImmediate(() => { if (stdout !== undefined) child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code); });
      },
    });
    child.kill = () => { child.killed = true; };
    return child;
  };
  const calls = [];
  const spawnWith = child => (command, args) => { calls.push({ command, args, child }); if (child instanceof Error) throw child; return child; };
  const run = async (spawn, input = {}, options = {}) => {
    const hooks = await FonnFilter({ directory: project }, { spawn, ...options });
    const output = { title: 'vendor/bin/phpunit', output: text, metadata: { exit: 1 } };
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'vendor/bin/phpunit' }, ...input }, output);
    return output;
  };
  const mutated = await run(spawnWith(fakeChild('{"updated_output":"filtered text"}\n')));
  assert.equal(mutated.output, 'filtered text');
  assert.deepEqual(mutated.metadata, { exit: 1 });
  const [call] = calls;
  assert.equal(call.command, 'node');
  assert.deepEqual(call.args, [script, 'hook', '--provider', 'opencode', '--mode', 'filter', '--level', 'standard', '--state-dir', join(project, '.fonn/filtering')]);
  assert.deepEqual(JSON.parse(call.child.input), { hook_event_name: 'PostToolUse', tool_name: 'bash', session_id: 'ses_1', tool_use_id: 'call_1', tool_input: { command: 'vendor/bin/phpunit' }, tool_response: text, cwd: project });
  for (const spawn of [
    spawnWith(fakeChild('{}\n')), spawnWith(fakeChild('not json')), spawnWith(fakeChild('{"updated_output":"x"}', { code: 1 })),
    spawnWith(fakeChild('{"updated_output":42}')), spawnWith(new Error('spawn failed')),
  ]) assert.equal((await run(spawn)).output, text);
  const hanging = fakeChild(undefined, { close: false });
  const started = Date.now();
  assert.equal((await run(spawnWith(hanging), {}, { timeoutMs: 50 })).output, text);
  assert(hanging.killed && Date.now() - started < 4000);
  calls.length = 0;
  assert.equal((await run(spawnWith(fakeChild('{"updated_output":"x"}')), { tool: 'read' })).output, text);
  assert.equal(calls.length, 0);

  // End to end with the real hook: a copied plugin finds it through FONN_FILTER_HOOK and FONN_FILTER_NODE.
  const names = ['FONN_FILTER_HOOK', 'FONN_FILTER_NODE', 'FONN_FILTER_STATE_DIR'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  const plugins = join(temporary, 'plugins');
  await mkdir(plugins);
  await cp(join(directory, 'opencode-plugin.js'), join(plugins, 'fonn-filter.js'));
  const { FonnFilter: Installed } = await import(pathToFileURL(join(plugins, 'fonn-filter.js')).href);
  Object.assign(process.env, { FONN_FILTER_HOOK: script, FONN_FILTER_NODE: process.execPath, FONN_FILTER_STATE_DIR: join(temporary, 'opencode-plugin-state') });
  const hooks = await Installed({ directory: project });
  const real = { title: 'vendor/bin/phpunit', output: text, metadata: {} };
  await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_2', callID: 'call_2', args: { command: 'vendor/bin/phpunit' } }, real);
  assert(real.output.length < text.length);
  assert(real.output.includes('WARNING: preserve this warning'));
  assert.match(real.output, /\[fonn: full original tool response archived as /);
  assert.equal((await readdir(join(temporary, 'opencode-plugin-state'))).length, 1);
  assert.deepEqual(Object.keys(await import(pathToFileURL(join(plugins, 'fonn-filter.js')).href)), ['FonnFilter'], 'OpenCode loads every export as a plugin');
});
