import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile, chmod, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const packages = await lstat(path.join(root, 'packages'));
if (!packages.isDirectory() || packages.isSymbolicLink()) throw new Error('Workspace parent must be a physical directory.');
for (const name of ['core', 'cli']) {
  const directory = path.join(root, 'packages', name);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Workspace directories must not be symlinks.');
  // Remove the directory or final symlink itself before compiling, so renamed
  // source files cannot survive as stale public release code.
  await rm(path.join(directory, 'dist'), { recursive: true, force: true });
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build', '--workspace', `@nord-forge/fonn-${name}`], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await rm(path.join(root, 'dist'), { recursive: true, force: true });
await mkdir(path.join(root, 'dist/cli'), { recursive: true });
const exports = "export * from '@nord-forge/fonn-core';\nexport * from '@nord-forge/fonn-cli';\n";
await writeFile(path.join(root, 'dist/index.js'), exports);
await writeFile(path.join(root, 'dist/index.d.ts'), exports);
for (const [name, args] of [['main', 'process.argv.slice(2)']]) {
  const file = path.join(root, 'dist/cli', `${name}.js`);
  await writeFile(file, "#!/usr/bin/env node\nimport { dispatch } from '@nord-forge/fonn-cli';\nprocess.exitCode = await dispatch(" + args + ");\n");
  await chmod(file, 0o755);
}
for (const name of ['main']) await chmod(path.join(root, 'packages/cli/dist/cli', `${name}.js`), 0o755);
