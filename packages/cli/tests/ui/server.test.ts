import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactStore } from '@nord-forge/fonn-core/filtering';
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

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
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

  const server = await startUiServer({ port: 0, configDirectory: config, stateDirectory: state });
  t.after(() => server.close());
  return { server, project, outsider, repository, launch, launchId, artifactId: artifact.id, characters: artifact.characters };
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
