import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HookRuntimeOptions } from '../../src/hooks/command.js';

/** A temporary home, config and state folder. Nothing reads the real user config. */
export async function hookFixture(t: { after: (fn: () => Promise<void>) => void }, name = 'install') {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), `fonn-hooks-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'fonn install');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  const node = path.join(bin, 'node');
  const main = path.join(bin, 'packages', 'cli', 'dist', 'cli', 'main.js');
  await mkdir(path.dirname(main), { recursive: true });
  await writeFile(node, '#!/bin/sh\n', { mode: 0o700 });
  await writeFile(main, '// offline test entrypoint\n');
  // Fonn's CLI package, so the entrypoint counts as Fonn's own.
  await writeFile(path.join(bin, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@nord-forge/fonn-cli' }));
  const options: HookRuntimeOptions = {
    home, env: {}, configDirectory: path.join(root, 'config'), stateDirectory: path.join(root, 'state'),
    command: [node, main], which: async () => false,
  };
  return { root, home, node, main, options };
}

export const phpunitOutput = 'PHPUnit 12.0.0 by Sebastian Bergmann and contributors.\n' + ('.'.repeat(60) + ' 100 / 100 (100%)\n').repeat(70) + '\nTime: 00:00.100\nOK (100 tests, 100 assertions)\n';
