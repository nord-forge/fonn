import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareRelease, validateVersion } from '../../scripts/release/prepare.mjs';
import { assertNodeVersion, installRuntime, uninstallRuntime } from '../../packaging/homebrew/runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function put(directory, path, content) {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fonn-packaging-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = { name: 'fonn', private: true, version: '0.1.0', type: 'module', workspaces: ['packages/*'] };
  await put(directory, 'package.json', manifest);
  const packages = { '': manifest };
  for (const name of ['core', 'cli']) {
    const pkg = { name: `@nord-forge/fonn-${name}`, version: '0.1.0', type: 'module', dependencies: name === 'core' ? { '@anthropic-ai/claude-agent-sdk': '0.3.319', zod: '4.1.12' } : { '@nord-forge/fonn-core': '0.1.0' } };
    await put(directory, `packages/${name}/package.json`, pkg);
    packages[`packages/${name}`] = pkg;
    packages[`node_modules/${pkg.name}`] = { resolved: `packages/${name}`, link: true };
  }
  await put(directory, 'package-lock.json', { name: 'fonn', version: '0.1.0', lockfileVersion: 3, packages });
  await put(directory, 'packages/core/dist/index.js', 'export const core = true;\n');
  await put(directory, 'packages/cli/dist/cli/main.js', 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n');
  await put(directory, 'dist/cli/main.js', 'import "../../packages/cli/dist/cli/main.js";\n');
  for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await put(directory, name, name);
  await cp(join(root, 'packaging'), join(directory, 'packaging'), { recursive: true });
  await put(directory, '.fonn-release.json', { format: 1, name: 'fonn', version: '0.1.0' });
  return directory;
}

test('release archive is deterministic, checksummed, confined, and requires valid versions and built workspaces', async t => {
  const directory = await fixture(t);
  for (const path of ['node_modules/secret.js', '.git/config', '.env', '.local/state/run.json', 'src/private.ts', 'packages/core/dist/node_modules/sdk.js', 'packages/core/dist/.env', 'packages/core/dist/src/private.js', 'packages/cli/dist/main.js.map', 'packages/cli/dist/declarations.d.ts']) await put(directory, path, 'PRIVATE');
  const first = await prepareRelease({ root: directory });
  const bytes = await readFile(first.archive);
  const second = await prepareRelease({ root: directory, outputDirectory: join(directory, 'other-output') });
  assert.deepEqual(await readFile(second.archive), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await readFile(first.checksums, 'utf8'), `${digest}  fonn-0.1.0.tar.gz\n`);
  const listing = spawnSync('tar', ['-tzf', first.archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const paths = listing.stdout.trim().split('\n');
  assert(paths.every(path => path.startsWith('fonn/') && !path.includes('../')));
  assert(paths.includes('fonn/packages/cli/dist/cli/main.js'));
  assert(paths.includes('fonn/packages/core/package.json'));
  assert(paths.includes('fonn/package-lock.json'));
  assert(paths.includes('fonn/dist/cli/main.js'));
  assert(paths.includes('fonn/THIRD_PARTY_NOTICES.md'));
  assert(paths.includes('fonn/packaging/homebrew/runtime.mjs'));
  assert(!paths.some(path => /node_modules|\.git|\.env|\.local|\/src\/|\.map$|\.d\.ts$/.test(path)));
  for (const version of ['v0.1.0', '../0.1.0', '0.01.0', '0.1', '', undefined]) assert.throws(() => validateVersion(version), /Invalid release version/);
  await put(directory, 'packages/core/package.json', { name: '@nord-forge/fonn-core', version: '0.2.0' });
  await assert.rejects(prepareRelease({ root: directory }), /version 0.1.0/);
  await put(directory, 'packages/core/package.json', { name: '@nord-forge/fonn-core', version: '0.1.0', dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.319', zod: '4.1.12' } });
  const outside = await mkdtemp(join(tmpdir(), 'fonn-external-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await put(outside, 'private-config.json', 'PRIVATE');
  await rm(join(directory, 'dist'), { recursive: true });
  await symlink(outside, join(directory, 'dist'));
  await assert.rejects(prepareRelease({ root: directory }), /Symlinks are not allowed/);
  await rm(join(directory, 'dist'));
  await rm(join(directory, 'packages/cli/dist'), { recursive: true });
  await assert.rejects(prepareRelease({ root: directory }), /Missing build output.*npm run build/);
});

test('generated CLI cask has the local checksum, Homebrew node, Sonoma floor, the CLI command and paired lifecycle stanzas', async t => {
  const result = await prepareRelease({ root: await fixture(t) });
  const cask = await readFile(result.cask, 'utf8');
  assert(cask.includes(`version "0.1.0"`));
  assert(cask.includes(`sha256 "${result.sha256}"`));
  assert(cask.includes('https://github.com/nord-forge/fonn/releases/download/v#{version}/fonn-#{version}.tar.gz'));
  assert(cask.includes('depends_on formula: "node"'));
  assert(cask.includes('depends_on macos: ">= :sonoma"'));
  assert(cask.includes('command_wrapper "fonn"'));
  assert(cask.includes('#{Formula["node"].opt_bin}/node'));
  assert(cask.includes('installer script:'));
  assert(cask.includes('uninstall script:'));
  assert.equal((cask.match(/sudo:\s+false/g) ?? []).length, 2);
  assert(!/no_check|@VERSION@|@SHA256@|zap |sudo:\s+true/.test(cask));
});

test('installer disables lifecycle scripts and inherited npm configuration; uninstall cannot follow dependency symlinks into user state', async t => {
  const directory = await fixture(t);
  assert.throws(() => assertNodeVersion('20.19.0'), /Node.js 22 or later/);
  assertNodeVersion('22.0.0');
  const npmCli = join(directory, 'mock-npm.mjs');
  await writeFile(npmCli, 'import {writeFileSync} from "node:fs"; writeFileSync("npm-call.json", JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));\n');
  const scriptPath = join(directory, 'packaging/homebrew/runtime.mjs');
  await installRuntime({ scriptPath, npmCli, environment: { ...process.env, npm_config_ignore_scripts: 'false', NPM_CONFIG_GLOBAL: 'true', npm_lifecycle_script: 'touch BAD', NODE_OPTIONS: '--invalid-node-option' } });
  const call = JSON.parse(await readFile(join(directory, 'npm-call.json'), 'utf8'));
  assert.deepEqual(call.args, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(await realpath(call.cwd), await realpath(directory));
  assert(!Object.keys(call.env).some(key => /^npm_/i.test(key) || key === 'NODE_OPTIONS'));
  const userState = join(directory, 'user-state');
  await put(userState, 'keep.json', 'KEEP');
  await symlink(userState, join(directory, 'node_modules'));
  await symlink(userState, join(directory, 'packages/cli/node_modules'));
  await put(directory, 'packages/core/node_modules/runtime/package.json', '{}');
  await uninstallRuntime({ scriptPath });
  assert.equal(await readFile(join(userState, 'keep.json'), 'utf8'), 'KEEP');
  for (const path of ['node_modules', 'packages/core/node_modules', 'packages/cli/node_modules']) await assert.rejects(readFile(join(directory, path)), /ENOENT/);
  await rm(join(directory, '.fonn-release.json'));
  await assert.rejects(uninstallRuntime({ scriptPath }), /ENOENT/);
});

test('physical staged launchers preserve arguments and caller cwd through symlinks', async t => {
  const directory = await fixture(t);
  const caller = join(directory, 'caller with spaces');
  await mkdir(caller);
  const link = join(directory, 'linked launcher.mjs');
  await symlink(join(directory, 'packaging/homebrew/launcher.mjs'), link);
  const args = ['--cwd', '/project with spaces', '--', '--resume', 'literal $HOME; *'];
  for (const command of ['fonn']) {
    const result = spawnSync(process.execPath, [link, command, ...args], { cwd: caller, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, args);
    assert.equal(output.cwd, await realpath(caller));
  }
});
