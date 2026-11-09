import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertNodeVersion(version = process.versions.node) {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || Number(version.split('.')[0]) < 22) {
    throw new Error(`Fonn requires Node.js 22 or later; found ${version}. Upgrade Homebrew node and retry.`);
  }
}

export async function stagedRoot(scriptPath = fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(await realpath(scriptPath)), '../..');
  const marker = JSON.parse(await readFile(join(root, '.fonn-release.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (marker.format !== 1 || marker.name !== 'fonn' || marker.version !== manifest.version) {
    throw new Error('Refusing to change dependencies outside a verified Fonn release payload.');
  }
  for (const workspace of ['core', 'cli']) {
    const path = join(root, 'packages', workspace);
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) {
      throw new Error('Release workspace must be a physical directory inside the staged payload.');
    }
    const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    if (pkg.name !== `@nord-forge/fonn-${workspace}` || pkg.version !== marker.version) {
      throw new Error('Release workspace does not match the staged payload.');
    }
  }
  return root;
}

export function npmInstallCommand(root, npmCli, node = process.execPath) {
  return { executable: node, args: [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: root };
}

export function installerEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^npm_/i.test(key) && key !== 'NODE_OPTIONS'));
}

export async function installRuntime({ scriptPath, npmCli, node = process.execPath, environment = process.env } = {}) {
  assertNodeVersion();
  if (!npmCli) throw new Error('Pass --npm /absolute/path/to/Homebrew/node/bin/npm.');
  const root = await stagedRoot(scriptPath);
  const command = npmInstallCommand(root, await realpath(npmCli), node);
  const result = spawnSync(command.executable, command.args, { cwd: command.cwd, env: installerEnvironment(environment), stdio: 'inherit' });
  if (result.error) throw new Error(`Could not run npm ci: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ci failed (${result.signal ?? result.status}); check network access and retry the cask installation.`);
}

export async function uninstallRuntime({ scriptPath } = {}) {
  const root = await stagedRoot(scriptPath);
  // rm removes a final symlink itself; it never follows that link into user state.
  for (const relative of ['node_modules', 'packages/core/node_modules', 'packages/cli/node_modules']) {
    await rm(join(root, relative), { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === 'install' && args.length === 3 && args[1] === '--npm') return installRuntime({ npmCli: args[2] });
  if (args[0] === 'uninstall' && args.length === 1) return uninstallRuntime();
  throw new Error('Usage: node runtime.mjs install --npm /path/to/npm | uninstall');
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
