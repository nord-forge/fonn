import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function launcherArguments(command, args) {
  if (command === 'fonn') return args;
  throw new Error('Expected fonn launcher name.');
}

export async function launch(command, args, scriptPath = fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(await realpath(scriptPath)), '../..');
  const entrypoint = await realpath(resolve(root, 'packages/cli/dist/cli/main.js'));
  // Keep the caller's working directory. The CLI's direct-entry guard sees its
  // physical path, including when the Homebrew command or this file is symlinked.
  process.argv = [process.execPath, entrypoint, ...launcherArguments(command, args)];
  await import(pathToFileURL(entrypoint).href);
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { await launch(process.argv[2], process.argv.slice(3)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
