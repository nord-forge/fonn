import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LOCAL_BASE_URLS } from '@nord-forge/fonn-core/agent';
import { createProfileStore } from '@nord-forge/fonn-core/profiles';
import { dispatch, type CliDependencies } from '../../src/cli/main.js';
import type { ChatOptions } from '../../src/agent/chat.js';

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'fonn-chat-args-'));
  const root = join(directory, 'project');
  const configDirectory = join(directory, 'config');
  await mkdir(root);
  const store = createProfileStore(configDirectory);
  const calls: ChatOptions[] = [];
  let out = '';
  let err = '';
  const env: NodeJS.ProcessEnv = { FONN_CONFIG_DIR: configDirectory };
  const deps: Partial<CliDependencies> = {
    env, stdout: text => { out += text; }, stderr: text => { err += text; },
    runChat: async options => { calls.push(options); return 7; },
  };
  return {
    root, directory, store, calls, env, deps, out: () => out, err: () => err,
    run: (args: string[]) => dispatch(['chat', ...args, '--cwd', root], deps),
    clean: () => rm(directory, { recursive: true, force: true }),
  };
}

test('chat resolves a Codex profile with either local source', async () => {
  const h = await fixture();
  try {
    for (const source of ['ollama', 'lmstudio'] as const) {
      await h.store.create({ name: source, provider: 'codex', model: 'qwen3:27b', effort: 'medium', source });
      assert.equal(await h.run(['--profile', source]), 7, h.err());
      assert.deepEqual(h.calls.at(-1), { model: 'qwen3:27b', baseUrl: LOCAL_BASE_URLS[source], root: h.root, contextTokens: 32768, filterMode: 'filter', filterLevel: 'standard' });
    }
    assert.equal(h.out(), '');
  } finally { await h.clean(); }
});

test('chat resolves explicit models, source defaults, context and state root', async () => {
  const h = await fixture();
  try {
    assert.equal(await h.run(['--model', 'gemma4:26b', '--source', 'lmstudio', '--context', '8192', '--state-dir', join(h.directory, 'state')]), 7);
    assert.deepEqual(h.calls[0], { model: 'gemma4:26b', baseUrl: LOCAL_BASE_URLS.lmstudio, root: h.root, contextTokens: 8192, filterMode: 'filter', filterLevel: 'standard', stateDirectory: join(h.directory, 'state') });
    assert.equal(await h.run(['--model', 'qwen3:27b']), 7);
    assert.equal(h.calls.at(-1)?.baseUrl, LOCAL_BASE_URLS.ollama);
  } finally { await h.clean(); }
});

test('base URL overrides a source and reads only the named API key variable', async () => {
  const h = await fixture();
  try {
    h.env.FONN_TEST_MODEL_KEY = 'fixture-secret';
    const baseUrl = 'https://example.invalid/v1';
    assert.equal(await h.run(['--model', 'kimi-k3', '--source', 'lmstudio', '--base-url', baseUrl, '--api-key-env', 'FONN_TEST_MODEL_KEY']), 7);
    assert.equal(h.calls[0]?.apiKey, 'fixture-secret');
    assert.equal(h.calls[0]?.baseUrl, baseUrl);
    assert.doesNotMatch(h.out() + h.err(), /fixture-secret/);
    assert.equal(await h.run(['--profile', 'sonnet-medium', '--base-url', baseUrl]), 7);
    assert.equal(h.calls.at(-1)?.model, (await h.store.get('sonnet-medium')).model);
    assert.equal(h.calls.at(-1)?.apiKey, undefined);
    h.deps.runChat = async () => { throw new Error('Server echoed fixture-secret'); };
    assert.equal(await h.run(['--model', 'kimi-k3', '--base-url', baseUrl, '--api-key-env', 'FONN_TEST_MODEL_KEY']), 1);
    assert.match(h.err(), /Server echoed \[REDACTED\]/);
    assert.doesNotMatch(h.err(), /fixture-secret/);
  } finally { await h.clean(); }
});

test('an empty or missing named key errors before calling runChat', async () => {
  const h = await fixture();
  try {
    for (const value of [undefined, '', '   ']) {
      h.env.FONN_TEST_MODEL_KEY = value;
      assert.equal(await h.run(['--model', 'kimi-k3', '--base-url', 'https://example.invalid/v1', '--api-key-env', 'FONN_TEST_MODEL_KEY']), 1);
    }
    assert.equal(h.calls.length, 0);
    assert.match(h.err(), /Environment variable FONN_TEST_MODEL_KEY is empty or unset/);
  } finally { await h.clean(); }
});

test('chat rejects profiles without a local source unless a base URL is given', async () => {
  const h = await fixture();
  try {
    await h.store.create({ name: 'custom', provider: 'codex', model: 'qwen3:27b', source: 'provider:test', effort: 'medium' });
    for (const profile of ['opus-medium', 'codex:sol-medium', 'custom']) {
      assert.equal(await h.run(['--profile', profile]), 1);
    }
    assert.equal(h.calls.length, 0);
    assert.match(h.err(), /Codex profile with an ollama or lmstudio source/);
    assert.equal(await h.run(['--profile', 'custom', '--base-url', 'http://localhost:9999/v1']), 7);
    assert.equal(h.calls[0]?.model, 'qwen3:27b');
  } finally { await h.clean(); }
});

test('chat reuses project filter settings, rule approval and project root discovery', async () => {
  const h = await fixture();
  try {
    const child = join(h.root, 'src');
    await mkdir(child);
    const rule = { name: 'noise', command: 'npm test', remove: ['heartbeat'] };
    await writeFile(join(h.root, '.fonn.json'), JSON.stringify({ filterMode: 'observe', filterLevel: 'similar', rules: [rule] }));
    const run = (args: string[]) => dispatch(['chat', '--model', 'qwen3:27b', '--cwd', child, ...args], h.deps);
    assert.equal(await run([]), 7);
    assert.equal(h.calls[0]?.root, h.root);
    assert.equal(h.calls[0]?.filterMode, 'observe');
    assert.equal(h.calls[0]?.filterLevel, 'similar');
    assert.equal(h.calls[0]?.filterRules, undefined);
    assert.match(h.err(), /not approved for this project/);
    assert.equal(await dispatch(['config', 'approve-rules', '--cwd', child], h.deps), 0);
    assert.equal(await run(['--filter', 'filter', '--filter-level', 'strict']), 7);
    assert.deepEqual(h.calls.at(-1)?.filterRules, [rule]);
    assert.equal(h.calls.at(-1)?.filterMode, 'filter');
    assert.equal(h.calls.at(-1)?.filterLevel, 'strict');
  } finally { await h.clean(); }
});

test('chat help stays offline and invalid arguments never run a model', async () => {
  let out = '';
  const offline: Partial<CliDependencies> = {
    env: { FONN_CONFIG_DIR: '/dev/null/unreadable' }, stdout: text => { out += text; },
    runChat: async () => { throw new Error('must not run'); },
  };
  for (const args of [['help', 'chat'], ['chat', '--help'], ['chat', '--model', 'qwen3', '--help'], ['--help']]) {
    assert.equal(await dispatch(args, offline), 0);
  }
  assert.match(out, /fonn chat/);
  assert.match(out, /--api-key-env/);
  const h = await fixture();
  try {
    for (const args of [
      [], ['--profile', 'missing'], ['--model', 'x', '--profile', 'opus-medium'],
      ['--source', 'ollama'], ['--model', 'x', '--source', 'remote'],
      ['--model', 'x', '--context', '100'], ['--model', 'x', '--context', '2000.5'],
      ['--model', 'x', '--context', '9007199254740992'], ['--model', 'x', '--base-url', 'file:///tmp/model'],
      ['--model', 'x', '--filter', 'wrong'], ['--model', 'x', '--filter-level', 'loose'],
      ['--model', 'x', '--filter', 'off', '--filter-level', 'strict'], ['--model', 'x', '--yes'],
    ]) assert.equal(await h.run(args), 1, JSON.stringify(args));
    assert.equal(h.calls.length, 0);
  } finally { await h.clean(); }
});
