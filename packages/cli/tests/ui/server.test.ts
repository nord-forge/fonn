import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactStore } from '@nord-forge/fonn-core/filtering';
import type { UiHooks } from '../../src/ui/api.js';
import { afterFingerprint, beforeFingerprint } from '../../src/ui/api.js';
import { startUiServer } from '../../src/ui/server.js';

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function send(port: number, target: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path: target, method: options.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...options.headers } }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
    });
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, hooks?: UiHooks) {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fonn-ui-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const outsider = path.join(base, 'outsider');
  const state = path.join(base, 'state');
  const config = path.join(base, 'config');
  await mkdir(path.join(project, '.git'), { recursive: true });
  // The outsider has no .git or settings file, so it is not a project.
  await mkdir(outsider, { recursive: true });
  const repository = path.join(base, 'repository');
  await mkdir(path.join(repository, '.git'), { recursive: true });
  await writeFile(path.join(project, '.fonn.json'), '{"filterLevel":"loud"}\n');
  await writeFile(path.join(project, 'AGENTS.md'), '# Synthetic instructions\n');
  await writeFile(path.join(outsider, 'secret.md'), 'not for the interface\n');
  await symlink(path.join(outsider, 'secret.md'), path.join(project, 'CLAUDE.md'));

  const launchId = randomUUID();
  const launch = path.join(state, 'native', launchId);
  await mkdir(path.join(launch, 'filters'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(launch, 'launch.json'), JSON.stringify({
    schemaVersion: 1, launchId, cwd: project, profile: 'opus-medium', filterMode: 'filter',
    createdAt: '2026-01-02T03:04:05.000Z', hookEntrypoint: '/synthetic/main.js', finishedAt: '2026-01-02T03:10:00.000Z', exitCode: 0,
  }));
  const artifact = await createArtifactStore(path.join(launch, 'artifacts')).save({ toolName: 'Bash', sessionId: 's', toolUseId: 't', response: { stdout: 'x'.repeat(50) } });
  const decision = (status: string, extra: object) => ({ mode: 'filter', status, originalCharacters: 100, proposedCharacters: 40, deliveredCharacters: 40, removedLines: 3, reason: 'synthetic', ...extra });
  await writeFile(path.join(launch, 'filters', `${'a'.repeat(64)}.json`), JSON.stringify(decision('filtered', { adapter: 'synthetic', artifactId: artifact.id })));
  await writeFile(path.join(launch, 'filters', `${'b'.repeat(64)}.json`), JSON.stringify({ ...decision('unchanged', {}), deliveredCharacters: 100, removedLines: 0 }));
  // A broken launch folder must be skipped rather than failing the listing.
  await mkdir(path.join(state, 'native', randomUUID()), { mode: 0o700 });

  const server = await startUiServer({ port: 0, configDirectory: config, stateDirectory: state, folderPicker: null, hooks });
  t.after(() => server.close());
  return { server, project, outsider, repository, launch, launchId, config, state, artifactId: artifact.id, characters: artifact.characters };
}

test('fonn ui guards every request and exchanges the token for a cookie', async (t) => {
  const { server } = await fixture(t);
  const { port, token } = server;
  const auth = { Authorization: `Bearer ${token}` };

  const exchange = await send(port, `/?token=${token}`);
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.location, '/');
  const cookie = String(exchange.headers['set-cookie']?.[0]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const page = await send(port, '/', { headers: { Cookie: cookie.split(';')[0]! } });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);

  assert.equal((await send(port, `/?token=wrong`)).status, 401);
  assert.equal((await send(port, '/api/overview')).status, 401);
  // A page request without a session gets readable HTML, not JSON.
  const expired = await send(port, '/');
  assert.equal(expired.status, 401);
  assert.match(String(expired.headers['content-type']), /text\/html/);
  assert.equal((await send(port, '/api/overview', { headers: { Cookie: `fonn_ui_${port}=wrong` } })).status, 401);
  assert.equal((await send(port, '/api/overview', { headers: { ...auth, Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await send(port, '/api/overview', { headers: { ...auth, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await send(port, '/api/overview', { headers: { ...auth, Origin: `http://127.0.0.1:${port}` } })).status, 200);
  const post = await send(port, '/api/overview', { method: 'POST', headers: auth });
  assert.equal(post.status, 405);
  assert.equal(post.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'");
  assert.equal(post.headers['access-control-allow-origin'], undefined);
  assert.equal((await send(port, '/missing.js', { headers: auth })).status, 404);
  // The home folder, which the page shows as ~, needs a session like every other API.
  assert.equal((await send(port, '/api/session')).status, 401);
  const session = await send(port, '/api/session', { headers: auth });
  assert.equal(session.status, 200);
  assert.equal(typeof JSON.parse(session.body).home, 'string');
});

test('fonn ui api reports synthetic state and refuses unknown roots and bad bounds', async (t) => {
  const { server, project, outsider, repository: fixtureRepository, launchId, artifactId, characters } = await fixture(t);
  const get = async (target: string) => {
    const reply = await send(server.port, target, { headers: { Authorization: `Bearer ${server.token}` } });
    assert.equal(reply.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'");
    assert.equal(reply.headers['cache-control'], 'no-store');
    return { status: reply.status, body: JSON.parse(reply.body) };
  };
  const root = encodeURIComponent(project);

  const overview = await get('/api/overview');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.counts, { profiles: overview.body.counts.profiles, projects: 1, launches: 1, runs: 0 });

  const projects = await get('/api/projects');
  assert.deepEqual(projects.body.projects.map((item: { root: string; launches: number; hasSharedSettings: boolean }) => [item.root, item.launches, item.hasSharedSettings]), [[project, 1, true]]);

  const detail = await get(`/api/project?root=${root}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.effective, null);
  assert.equal(detail.body.shared.exists, true);
  assert.match(detail.body.shared.error, /filterLevel/);
  assert.equal(detail.body.local.exists, false);
  assert.equal(detail.body.totals.decisions, 2);
  assert.equal(detail.body.totals.filtered, 1);
  const instructions = Object.fromEntries(detail.body.instructions.map((item: { name: string; exists: boolean }) => [item.name, item.exists]));
  assert.deepEqual(instructions, { 'CLAUDE.md': false, 'AGENTS.md': true, '.claude/CLAUDE.md': false, 'CLAUDE.local.md': false });
  assert.deepEqual((await get(`/api/project/instructions?root=${root}&name=AGENTS.md`)).body, { name: 'AGENTS.md', text: '# Synthetic instructions\n', truncated: false });
  assert.equal((await get(`/api/project/instructions?root=${root}&name=CLAUDE.md`)).status, 404);
  assert.equal((await get(`/api/project/instructions?root=${root}&name=../secret.md`)).status, 400);

  assert.equal((await get(`/api/project?root=${encodeURIComponent(outsider)}`)).status, 404);
  // A Git repository root is allowed even before any launch used it.
  const repository = await get(`/api/project?root=${encodeURIComponent(path.join(fixtureRepository, 'sub'))}`);
  assert.equal(repository.status, 200);
  assert.equal(repository.body.root, fixtureRepository);
  assert.equal((await get('/api/project?root=relative/path')).status, 400);
  assert.equal((await get(`/api/launches?root=${encodeURIComponent(outsider)}`)).status, 404);

  const launches = await get(`/api/launches?root=${root}`);
  assert.equal(launches.body.launches.length, 1);
  const [summary] = launches.body.launches;
  assert.equal(summary.launchId, launchId);
  assert.equal(summary.filterLevel, 'strict');
  assert.equal(summary.provider, 'claude');
  assert.deepEqual(summary.totals, { decisions: 2, filtered: 1, observed: 0, unchanged: 1, originalCharacters: 200, deliveredCharacters: 140, removedLines: 3 });

  const launch = await get(`/api/launches/${launchId}`);
  assert.equal(launch.body.decisions.length, 2);
  assert.ok(launch.body.decisions.some((item: { artifactId: string | null }) => item.artifactId === artifactId));
  assert.equal((await get('/api/launches/not-an-id')).status, 400);
  assert.equal((await get(`/api/launches/${randomUUID()}`)).status, 404);

  const slice = await get(`/api/launches/${launchId}/artifacts/${artifactId}?offset=5&limit=10`);
  assert.equal(slice.status, 200);
  assert.equal(slice.body.text.length, 10);
  assert.equal(slice.body.offset, 5);
  assert.equal(slice.body.nextOffset, 15);
  assert.equal(slice.body.totalCharacters, characters);
  assert.equal((await get(`/api/launches/${launchId}/artifacts/${artifactId}?limit=20001`)).status, 400);
  assert.equal((await get(`/api/launches/${launchId}/artifacts/${artifactId}?limit=0`)).status, 400);
  assert.equal((await get(`/api/launches/${launchId}/artifacts/${artifactId}?offset=-1`)).status, 400);
  assert.equal((await get(`/api/launches/${launchId}/artifacts/${randomUUID()}`)).status, 404);

  assert.deepEqual((await get('/api/runs')).body, { runs: [] });
  const global = await get('/api/settings/global');
  assert.equal(global.body.settings.profile, 'opus-medium');
  assert.match(global.body.delegationGuidance, /subagents/);
});

function changer(server: { port: number; token: string }) {
  const origin = `http://127.0.0.1:${server.port}`;
  return async (method: string, target: string, body?: unknown, headers: Record<string, string> = {}) => {
    const reply = await send(server.port, target, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${server.token}`, Origin: origin, 'X-Fonn-Request': '1', 'Content-Type': 'application/json', ...headers },
    });
    return { status: reply.status, headers: reply.headers, body: JSON.parse(reply.body) };
  };
}

test('fonn ui changes need the origin, the request header, JSON and a small body', async (t) => {
  const { server } = await fixture(t);
  const change = changer(server);
  const body = { command: 'npm test', stdout: 'ok' };
  assert.equal((await change('POST', '/api/filter/test', body)).status, 200);
  const withoutOrigin = await send(server.port, '/api/filter/test', { method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${server.token}`, 'X-Fonn-Request': '1', 'Content-Type': 'application/json' } });
  assert.equal(withoutOrigin.status, 403);
  assert.equal((await change('POST', '/api/filter/test', body, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await change('POST', '/api/filter/test', body, { 'X-Fonn-Request': '' })).status, 403);
  assert.equal((await change('POST', '/api/filter/test', body, { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal((await change('POST', '/api/filter/test', body, { Authorization: '' })).status, 401);
  // Other changes are capped at 64 KB; the test bench takes up to 512 KB.
  assert.equal((await change('PUT', '/api/settings/global/rules', { rules: [], padding: 'x'.repeat(70 * 1024) })).status, 413);
  assert.equal((await change('POST', '/api/filter/test', { command: 'npm test', stdout: 'x'.repeat(70 * 1024) })).status, 200);
  assert.equal((await change('POST', '/api/filter/test', { command: 'npm test', stdout: 'x'.repeat(600 * 1024) })).status, 413);
  const invalid = await send(server.port, '/api/filter/test', { method: 'POST', body: '{nope', headers: { Authorization: `Bearer ${server.token}`, Origin: `http://127.0.0.1:${server.port}`, 'X-Fonn-Request': '1', 'Content-Type': 'application/json' } });
  assert.equal(invalid.status, 400);
  const wrongMethod = await change('DELETE', '/api/overview');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, HEAD');
  assert.equal((await change('PUT', '/api/settings/global/rules', { rules: [] }, {})).status, 200);
  assert.equal((await change('GET', '/api/settings/global/rules')).status, 405);
  assert.equal((await change('POST', '/index.html', {})).status, 405);
});

test('fonn ui change endpoints save through the stores and refuse invalid values', async (t) => {
  const { server, project, launch, launchId } = await fixture(t);
  const change = changer(server);
  const root = project;

  const level = await change('PUT', '/api/settings/global', { key: 'filterLevel', value: 'similar' });
  assert.equal(level.status, 200);
  assert.equal(level.body.settings.filterLevel, 'similar');
  assert.equal((await change('PUT', '/api/settings/global', { key: 'filterLevel', value: null })).body.settings.filterLevel, undefined);
  assert.equal((await change('PUT', '/api/settings/global', { key: 'filterLevel', value: 'loud' })).status, 400);
  assert.equal((await change('PUT', '/api/settings/global', { key: 'colour', value: 'red' })).status, 400);

  const rule = { name: 'quiet-debug', command: 'npm test', remove: ['DEBUG noise'] };
  const rules = await change('PUT', '/api/settings/global/rules', { rules: [rule] });
  assert.deepEqual(rules.body.settings.rules, [rule]);
  const badRule = await change('PUT', '/api/settings/global/rules', { rules: [{ ...rule, remove: ['ab'] }] });
  assert.equal(badRule.status, 400);
  assert.match(badRule.body.error, /remove/);

  // Saves send the file's version from the last read, like the page does.
  const save = async (scope: 'shared' | 'local', settings: unknown) => {
    const current = (await change('GET', `/api/project?root=${encodeURIComponent(root)}`)).body;
    return change('PUT', '/api/project/settings', { root, scope, version: current[scope].version, settings });
  };
  // A file that changed since the page loaded is not overwritten.
  const loaded = (await change('GET', `/api/project?root=${encodeURIComponent(root)}`)).body;
  await writeFile(path.join(root, '.fonn.json'), JSON.stringify({ filterLevel: 'similar' }));
  const stale = await change('PUT', '/api/project/settings', { root, scope: 'shared', version: loaded.shared.version, settings: { filterMode: 'observe' } });
  assert.equal(stale.status, 409);
  assert.match(await readFile(path.join(root, '.fonn.json'), 'utf8'), /similar/);
  assert.equal((await change('PUT', '/api/project/settings', { root, scope: 'shared', settings: { filterMode: 'observe' } })).status, 400);

  const written = await save('shared', { filterMode: 'observe' });
  assert.equal(written.status, 200);
  assert.deepEqual(written.body.shared.settings, { filterMode: 'observe' });
  assert.equal(written.body.effective.filterMode.source, 'shared');
  assert.deepEqual(written.body.effective.rules, [{ ...rule, source: 'global' }]);
  assert.equal((await save('shared', { filterMode: 'loud' })).status, 400);
  // Rules committed by someone else stay unapproved until the user approves them.
  const theirs = { name: 'theirs', command: 'npm audit', remove: ['found'] };
  await writeFile(path.join(root, '.fonn.json'), JSON.stringify({ rules: [theirs] }));
  let detail = (await change('GET', `/api/project?root=${encodeURIComponent(root)}`)).body;
  assert.equal(detail.rulesApproval.approved, false);
  assert.deepEqual(detail.effective.unapprovedRules.map((rule: { name: string }) => rule.name), ['theirs']);
  // Saving the personal file in the UI does not approve them.
  detail = (await save('local', { rules: [{ name: 'mine', command: 'make', remove: ['noise'] }] })).body;
  assert.equal(detail.rulesApproval.approved, false);
  assert.equal(detail.effective.rules.filter((rule: { source: string }) => rule.source !== 'global').length, 0);
  assert.equal((await change('PUT', '/api/project/rules-approval', { root, fingerprint: 'f'.repeat(64) })).status, 409);
  detail = (await change('PUT', '/api/project/rules-approval', { root, fingerprint: detail.rulesApproval.fingerprint })).body;
  assert.deepEqual(detail.effective.rules.filter((rule: { source: string }) => rule.source !== 'global').map((rule: { name: string }) => rule.name).sort(), ['mine', 'theirs']);
  // Once approved, the user's own edits keep the approval.
  detail = (await save('local', {})).body;
  assert.equal(detail.rulesApproval.approved, true);
  detail = (await change('PUT', '/api/project/rules-approval', { root, fingerprint: null })).body;
  assert.equal(detail.rulesApproval.approved, false);

  const removed = await save('shared', {});
  assert.equal(removed.body.shared.exists, false);

  const created = await change('POST', '/api/profiles', { name: 'my-review', provider: 'claude', model: 'claude-opus-5-5', effort: 'low' });
  assert.equal(created.status, 200);
  assert.ok(created.body.profiles.some((item: { name: string; builtIn: boolean }) => item.name === 'my-review' && !item.builtIn));
  assert.equal((await change('POST', '/api/profiles', { name: 'my-review', provider: 'claude', model: 'claude-opus-5-5', effort: 'low' })).status, 400);
  // A Codex profile can run a local or other model; null goes back to OpenAI.
  const qwen = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-IQ3_XXS';
  const local = await change('POST', '/api/profiles', { name: 'qwen-local', provider: 'codex', model: qwen, effort: 'medium', source: 'ollama' });
  assert.equal(local.status, 200);
  assert.deepEqual(local.body.profiles.find((item: { name: string }) => item.name === 'qwen-local'), { name: 'qwen-local', provider: 'codex', model: qwen, effort: 'medium', source: 'ollama', builtIn: false, isDefault: false });
  assert.equal((await change('POST', '/api/profiles', { name: 'bad-source', provider: 'codex', model: 'qwen3', effort: 'low', source: 'provider:a b' })).status, 400);
  assert.equal((await change('PUT', '/api/profiles/qwen-local', { source: null })).status, 400, 'an open model name needs a source');
  const openai = await change('PUT', '/api/profiles/qwen-local', { source: null, model: 'gpt-6.1-sol' });
  assert.equal(openai.body.profiles.find((item: { name: string }) => item.name === 'qwen-local').source, null);
  assert.equal(created.body.profiles.find((item: { name: string }) => item.name === 'my-review').source, null);

  const edited = await change('PUT', '/api/profiles/my-review', { effort: 'high' });
  assert.equal(edited.body.profiles.find((item: { name: string }) => item.name === 'my-review').effort, 'high');
  assert.equal((await change('PUT', '/api/profiles/my-review', {})).status, 400);
  const builtIn = await change('PUT', '/api/profiles/opus-medium', { effort: 'high' });
  assert.equal(builtIn.status, 400);
  assert.match(builtIn.body.error, /immutable/);
  assert.equal((await change('DELETE', '/api/profiles/opus-medium')).status, 400);
  const deleted = await change('DELETE', '/api/profiles/my-review');
  assert.ok(!deleted.body.profiles.some((item: { name: string }) => item.name === 'my-review'));

  const stdout = Array.from({ length: 120 }, (_, index) => index >= 60 ? `DEBUG noise from step ${index}` : `step ${index} passed`).join('\n');
  const tested = await change('POST', '/api/filter/test', { command: 'npm test', stdout, mode: 'filter', level: 'strict' });
  assert.equal(tested.status, 200);
  assert.deepEqual(tested.body.rules, [rule]);
  assert.equal(tested.body.decision.status, 'filtered');
  assert.equal(tested.body.decision.removedLines, 60);
  assert.equal(tested.body.decision.artifactId, null);
  assert.doesNotMatch(tested.body.delivered, /DEBUG noise from/);
  assert.match(tested.body.delivered, /step 0 passed/);
  // Short output stays as it is, unless the rule builder asks for its preview at any size.
  const short = 'Waiting for database (attempt 1/10)\nWaiting for database (attempt 2/10)\nError: connection failed (attempt 3/10)\nready';
  const builderRule = { name: 'Database wait', command: 'npm run dev', remove: ['Waiting for database', 'connection failed'] };
  const plain = await change('POST', '/api/filter/test', { command: 'npm run dev', stdout: short, mode: 'filter', level: 'strict', rules: [builderRule] });
  assert.equal(plain.body.decision.status, 'unchanged');
  assert.equal(plain.body.delivered, short);
  const preview = await change('POST', '/api/filter/test', { command: 'npm run dev', stdout: short, mode: 'filter', level: 'strict', rules: [builderRule], anySize: true });
  assert.doesNotMatch(preview.body.delivered, /Waiting for database/);
  assert.match(preview.body.delivered, /Error: connection failed/);
  assert.equal((await change('POST', '/api/filter/test', { command: 'npm run dev', stdout: short, anySize: 'yes' })).status, 400);
  assert.equal((await change('POST', '/api/filter/test', { command: 'x'.repeat(2001), stdout })).status, 400);

  assert.equal((await change('DELETE', '/api/launches/not-an-id')).status, 400);
  assert.deepEqual((await change('DELETE', `/api/launches/${launchId}`)).body, { deleted: launchId });
  await assert.rejects(stat(launch), { code: 'ENOENT' });
  assert.equal((await change('DELETE', `/api/launches/${launchId}`)).status, 404);

  // A launch with no recorded finish may still be running, so it needs confirming.
  const runningId = '7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6';
  const running = path.join(path.dirname(launch), runningId);
  await mkdir(running, { recursive: true });
  await writeFile(path.join(running, 'launch.json'), JSON.stringify({ launchId: runningId, createdAt: '2026-01-02T03:04:05.000Z' }));
  assert.equal((await change('DELETE', `/api/launches/${runningId}`)).status, 409);
  await stat(running);
  assert.deepEqual((await change('DELETE', `/api/launches/${runningId}?confirm=running`)).body, { deleted: runningId });
  await assert.rejects(stat(running), { code: 'ENOENT' });
});

test('fonn ui opens one system folder dialog at a time and returns the chosen path', async (t) => {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fonn-ui-picker-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  let finish: (value: string | null) => void = () => {};
  const server = await startUiServer({
    port: 0, configDirectory: path.join(base, 'config'), stateDirectory: path.join(base, 'state'),
    folderPicker: () => new Promise((resolve) => { finish = resolve; }),
  });
  t.after(() => server.close());
  const change = changer(server);
  assert.deepEqual((await change('GET', '/api/pick-folder')).body, { supported: true });
  const first = change('POST', '/api/pick-folder', {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await change('POST', '/api/pick-folder', {})).status, 409, 'a second dialog waits for the first');
  finish('/Users/someone/code/app');
  assert.deepEqual((await first).body, { path: '/Users/someone/code/app' });
  // Opening the dialog is a change, so it needs the same guards.
  assert.equal((await change('POST', '/api/pick-folder', {}, { 'X-Fonn-Request': '' })).status, 403);

  const none = await startUiServer({ port: 0, configDirectory: path.join(base, 'config'), stateDirectory: path.join(base, 'state'), folderPicker: null });
  t.after(() => none.close());
  assert.deepEqual((await changer(none)('GET', '/api/pick-folder')).body, { supported: false });
  assert.equal((await changer(none)('POST', '/api/pick-folder', {})).status, 404);
});

test('hook endpoints validate plans, preserve change guards and pass configured directories', async (t) => {
  let before: string | null = null;
  let applied = 0;
  let conflict = false;
  let failure = false;
  const status = { agent: 'codex' as const, label: 'Codex', configPath: '/synthetic/.codex/hooks.json', detected: true, installed: false, current: false };
  const calls: unknown[] = [];
  const hooks: UiHooks = {
    planIdentity: () => 'fixture-identity',
    redactForDisplay: (text) => text,
    async hookStatus(options) { calls.push(options); return [status]; },
    async planHook(agent, action, options) {
      calls.push(options);
      if (failure) throw new SyntaxError('private configuration contents');
      return { agent, action, configPath: status.configPath, changes: true, before, after: '{"hooks":[]}', summary: ['Install the hook.'], files: [{ path: '/synthetic/plugin.js', action: 'write' }] };
    },
    async applyHookPlan(plan, options) {
      calls.push(options);
      if (conflict) { const error = new Error('private file contents'); error.name = 'HookConflictError'; throw error; }
      applied++;
      before = plan.after;
      return { ...status, installed: plan.action === 'install', current: plan.action === 'install' };
    },
  };
  const { server, config: configDirectory, state: stateDirectory } = await fixture(t, hooks);
  const auth = { Authorization: `Bearer ${server.token}` };
  const get = (target: string) => send(server.port, target, { headers: auth });
  const change = changer(server);
  const endpoint = '/api/hooks/codex/apply';
  assert.deepEqual(JSON.parse((await get('/api/hooks')).body), [status]);
  const planned = await get('/api/hooks/codex/plan?action=install');
  assert.equal(planned.status, 200);
  const plan = JSON.parse(planned.body);
  assert.equal(plan.before, null);
  assert.equal(plan.beforeHash, beforeFingerprint({ before: null }, 'fixture-identity'));
  assert.equal(plan.files[0].action, 'write');
  assert.equal((await get('/api/hooks/codex/plan?action=uninstall')).status, 200);
  for (const target of ['/api/hooks/unknown/plan?action=install', '/api/hooks/%63odex%2Fclaude/plan?action=install']) assert.equal((await get(target)).status, 404);
  for (const suffix of ['', '?action=remove', '?action=INSTALL']) assert.equal((await get(`/api/hooks/codex/plan${suffix}`)).status, 400);
  assert.equal((await change('POST', '/api/hooks/unknown/apply', { action: 'install', beforeHash: 'missing' })).status, 404);
  for (const body of [{ action: 'install' }, { action: 'remove', beforeHash: 'missing' }, { action: 'install', beforeHash: 42 }, { action: 'install', beforeHash: 'not-a-hash' }, { action: 'install', beforeHash: 'missing', extra: true }]) {
    assert.equal((await change('POST', endpoint, body)).status, 400);
  }
  const afterHash = afterFingerprint({ after: '{"hooks":[]}', files: [{ path: '/synthetic/plugin.js', action: 'write' }] });
  assert.equal(plan.afterHash, afterHash);
  const body = { action: 'install', beforeHash: 'missing', afterHash };
  assert.equal((await send(server.port, endpoint, { method: 'POST', headers: auth, body: JSON.stringify(body) })).status, 403);
  const invalidHeaders: Record<string, string>[] = [{ Origin: '' }, { Origin: 'http://evil.example' }, { 'X-Fonn-Request': '' }, { 'Content-Type': 'text/plain' }];
  for (const headers of invalidHeaders) {
    assert.equal((await change('POST', endpoint, body, headers)).status, 403);
  }
  assert.equal((await change('POST', endpoint, body, { Authorization: '' })).status, 401);
  assert.equal((await change('POST', endpoint, { ...body, padding: 'x'.repeat(70 * 1024) })).status, 413);
  const invalid = await send(server.port, endpoint, { method: 'POST', headers: { ...auth, Origin: `http://127.0.0.1:${server.port}`, 'X-Fonn-Request': '1', 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(invalid.status, 400);
  assert.equal(applied, 0);
  before = 'changed on disk';
  const stale = await change('POST', endpoint, body);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'The file changed. Review the new version.');
  assert.equal(applied, 0);
  conflict = true;
  const raced = await change('POST', endpoint, { ...body, beforeHash: beforeFingerprint({ before }, 'fixture-identity') });
  assert.equal(raced.status, 409);
  assert.doesNotMatch(raced.body.error, /private/);
  conflict = false;
  const changedPlan = await change('POST', endpoint, { ...body, beforeHash: beforeFingerprint({ before }, 'fixture-identity'), afterHash: 'a'.repeat(64) });
  assert.equal(changedPlan.status, 409, 'a different planned change is refused even when the file is the same');
  assert.match(changedPlan.body.error, /different now/);
  const installed = await change('POST', endpoint, { ...body, beforeHash: beforeFingerprint({ before }, 'fixture-identity') });
  assert.equal(installed.status, 200);
  assert.equal(installed.body.current, true);
  const removed = await change('POST', endpoint, { action: 'uninstall', beforeHash: beforeFingerprint({ before }, 'fixture-identity'), afterHash });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.installed, false);
  assert.equal(applied, 2);
  failure = true;
  const failed = await get('/api/hooks/codex/plan?action=install');
  assert.equal(failed.status, 400);
  assert.doesNotMatch(failed.body, /private configuration/);
  assert.ok(calls.length > 0);
  for (const options of calls) assert.deepEqual(options, { configDirectory, stateDirectory });
});

test('hook sessions list all agents without profiles and retain detail, recovery and deletion', async (t) => {
  const { server, launch, project, launchId: normalId } = await fixture(t);
  const native = path.dirname(launch);
  const ids: string[] = [];
  let artifactId = '';
  for (const provider of ['claude', 'codex', 'crush', 'opencode']) {
    const launchId = randomUUID();
    ids.push(launchId);
    const folder = path.join(native, launchId);
    await mkdir(folder);
    await writeFile(path.join(folder, 'launch.json'), JSON.stringify({
      schemaVersion: 1, origin: 'hook', provider, agentSessionId: `synthetic-${provider}`, launchId,
      cwd: project, filterMode: 'filter', filterLevel: 'standard', createdAt: '2026-02-01T00:00:00.000Z',
    }));
    const artifact = await createArtifactStore(path.join(folder, 'artifacts')).save({ toolName: 'Bash', sessionId: 'synthetic', toolUseId: provider, response: { stdout: 'synthetic hook output' } });
    artifactId = artifact.id;
  }
  const get = async (target: string) => {
    const reply = await send(server.port, target, { headers: { Authorization: `Bearer ${server.token}` } });
    return { status: reply.status, body: JSON.parse(reply.body) };
  };
  const listing = await get('/api/launches');
  assert.equal(listing.status, 200);
  assert.equal(listing.body.launches.length, 5);
  for (const [index, provider] of ['claude', 'codex', 'crush', 'opencode'].entries()) {
    const summary = listing.body.launches.find((item: { launchId: string }) => item.launchId === ids[index]);
    assert.equal(summary.origin, 'hook');
    assert.equal(summary.provider, provider);
    assert.equal(summary.providerLabel, ['Claude Code', 'Codex', 'Crush', 'OpenCode'][index]);
    assert.equal(summary.profile, null);
    const detail = await get(`/api/launches/${ids[index]}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.launch, summary);
  }
  assert.equal(listing.body.launches.find((item: { launchId: string }) => item.launchId === normalId).origin, 'launch');
  const slice = await get(`/api/launches/${ids[3]}/artifacts/${artifactId}?limit=200`);
  assert.equal(slice.status, 200);
  assert.match(slice.body.text, /synthetic hook output/);
  const change = changer(server);
  // Hook sessions never record a finish, so they delete without the running check.
  assert.equal((await change('DELETE', `/api/launches/${ids[3]}`)).status, 200);
  assert.equal((await get(`/api/launches/${ids[3]}`)).status, 404);
});
