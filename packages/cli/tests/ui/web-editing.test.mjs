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
