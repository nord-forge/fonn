// Offline checks of the web interface's request and validation helpers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { get, send, ApiError, projectRoute } from '../../src/ui/web/api.js';
import { ruleErrors } from '../../src/ui/web/rules.js';

const rule = { name: 'noise', command: 'npm run dev', remove: ['Waiting for database'] };
const valid = (rules) => ruleErrors(rules).every((errors) => Object.values(errors).every((value) => !value));

test('rules validate text lengths, single-line commands, and normalized unique names', () => {
  assert.ok(valid([rule]));
  assert.ok(valid([]));
  assert.ok(valid([{ name: 'x'.repeat(60), command: 'x'.repeat(200), remove: ['x'.repeat(3), 'x'.repeat(200)] }]));
  for (const name of ['', ' ', 'x'.repeat(61)]) assert.ok(!valid([{ ...rule, name }]));
  assert.ok(!valid([rule, { ...rule, name: ' noise ' }]));
  for (const command of ['', ' ', 'x'.repeat(201), 'npm\nrun dev', 'npm\0run dev']) assert.ok(!valid([{ ...rule, command }]));
  for (const remove of [[], ['ab'], ['x'.repeat(201)], ['a\0b'], Array(21).fill('abc')]) assert.ok(!valid([{ ...rule, remove }]));
  assert.ok(valid([{ ...rule, remove: Array(20).fill('abc') }]));
});

test('writes send JSON, same-origin credentials, and the request marker for every method', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ settings: { filterLevel: 'strict' } }));
  });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const result = await send(method, 'settings/global', { key: 'filterLevel', value: null });
    assert.equal(result.settings.filterLevel, 'strict');
    const { url, options } = calls.at(-1);
    assert.equal(url, '/api/settings/global');
    assert.equal(options.method, method);
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'X-Fonn-Request': '1' });
    assert.deepEqual(JSON.parse(options.body), { key: 'filterLevel', value: null });
  }
  await send('DELETE', 'launches/fixture');
  assert.equal(calls.at(-1).options.body, '{}');
});

test('server validation and size errors retain the exact safe error message', async (t) => {
  let status = 400;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: `Server message ${status}` }), { status }));
  for (status of [400, 403, 413]) {
    await assert.rejects(send('PUT', 'settings/global', {}), (error) => error instanceof ApiError && error.status === status && error.message === `Server message ${status}`);
  }
});

test('reads encode arbitrary project paths, remain offline-safe, and preserve aborts', async (t) => {
  const root = '/synthetic/a #?&/project';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url, 'http://fixture').searchParams.get('root'), root);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    return new Response('{"root":"fixture"}');
  });
  assert.equal((await get('project', { query: { root } })).root, 'fixture');
  assert.equal(decodeURIComponent(projectRoute(root).slice('#/project/'.length)), root);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(get('project', { query: { root }, signal: controller.signal }), { name: 'AbortError' });
});

test('session expiry emits the shared event, and unreadable replies stay errors', async (t) => {
  const window = new EventTarget();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = window;
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  let expired = false;
  window.addEventListener('fonn:session-expired', () => { expired = true; });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(send('DELETE', 'launches/fixture'), { status: 401 });
  assert.ok(expired);
  fetch.mock.mockImplementation(async () => new Response('not json', { status: 200 }));
  await assert.rejects(send('POST', 'filter/test', {}), /unreadable response/);
});

test('hook previews show exact added and removed lines with bounded context', async () => {
  const { hookDiff } = await import('../../src/ui/web/hook-diff.js');
  assert.deepEqual(hookDiff(null, 'new'), [{ kind: 'added', text: 'new' }]);
  assert.deepEqual(hookDiff('old', null), [{ kind: 'removed', text: 'old' }]);
  assert.deepEqual(hookDiff('same', 'same'), []);
  const diff = hookDiff('first\nold\nlast', 'first\nnew\nlast');
  assert.deepEqual(diff.filter((line) => line.kind !== 'context'), [{ kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }]);
  const large = hookDiff(Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n'), Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n'));
  assert.equal(large.filter((line) => line.kind === 'removed').length, 600);
  assert.equal(large.filter((line) => line.kind === 'added').length, 600);
});

test('agent badges give errors and stale installs precedence over detection', async () => {
  const { hookStatusBadge } = await import('../../src/ui/web/views/agents.js');
  assert.equal(hookStatusBadge({ error: 'bad', installed: true, current: true })[0], 'Error');
  assert.equal(hookStatusBadge({ installed: true, current: true })[0], 'Installed');
  assert.equal(hookStatusBadge({ installed: true, current: false, detected: false })[0], 'Needs update');
  assert.equal(hookStatusBadge({ installed: false, detected: true })[0], 'Not installed');
  assert.equal(hookStatusBadge({ installed: false, detected: false })[0], 'Not detected');
  const { displayPath, setHome } = await import('../../src/ui/web/components.js');
  assert.equal(displayPath('/Users/sam/.codex/hooks.json'), '/Users/sam/.codex/hooks.json');
  setHome('/Users/sam');
  assert.equal(displayPath('/Users/sam/.codex/hooks.json'), '~/.codex/hooks.json');
  assert.equal(displayPath('The checkout at /Users/sam/code/fonn, in every project.'), 'The checkout at ~/code/fonn, in every project.');
  assert.equal(displayPath('/Users/sam'), '~');
  assert.equal(displayPath('/Users/samuel/code'), '/Users/samuel/code');
  assert.equal(displayPath('/opt/config/hooks.json'), '/opt/config/hooks.json');
  setHome('');
  const { suggestText, sampleLines } = await import('../../src/ui/web/rules.js');
  assert.equal(suggestText('Waiting for database (attempt 3/10)'), 'Waiting for database (attempt');
  assert.equal(suggestText('  [12:04:33] Compiled 418 modules in 2.3s'), 'Compiled');
  assert.equal(suggestText('\u001b[32mready\u001b[0m - started server on 0.0.0.0:3000'), 'ready - started server on');
  assert.equal(suggestText('12 34'), '12 34');
  assert.deepEqual(sampleLines('one\r\ntwo\n'), ['one', 'two']);
});

test('the hook diff marks skipped lines, so separate changes never look adjacent', async () => {
  const { hookDiff } = await import('../../src/ui/web/hook-diff.js');
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  const after = before.replace('line 2', 'line two').replace('line 17', 'line seventeen');
  const diff = hookDiff(before, after);
  const kinds = diff.map((line) => line.kind);
  assert.equal(kinds.filter((kind) => kind === 'gap').length, 1, 'one gap between the two changes');
  const gap = kinds.indexOf('gap');
  assert.ok(kinds.slice(0, gap).includes('added') && kinds.slice(gap).includes('added'), 'a change on each side of the gap');
  assert.ok(diff.every((line) => line.kind !== 'context' || /line (?:[0-4]|1[5-9])$/.test(line.text)), 'only nearby context is kept');
});
