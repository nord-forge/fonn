import { isBuiltin } from 'node:module';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, join, parse, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const modules = ['index', 'adapters', 'artifact-store'];
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

async function readPhysicalSource(root, source) {
  const base = resolve(root);
  const location = resolve(base, source);
  const within = relative(base, location);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Standalone source must be within the repository');
  let current = parse(location).root;
  const components = location.slice(current.length).split(sep).filter(Boolean);
  let entry;
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    entry = await lstat(current);
    if (entry.isSymbolicLink() || (index === components.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error('Standalone sources must be physical regular files with physical directory parents');
    }
  }
  const file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > MAX_SOURCE_BYTES) throw new Error('Invalid standalone source file');
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_SOURCE_BYTES + 1 - bytes));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_SOURCE_BYTES) throw new Error('Standalone source exceeds size limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally { await file.close(); }
}

async function physicalDirectory(directory) {
  let current = parse(directory).root;
  for (const component of directory.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await mkdir(current); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Standalone output directories must be physical directories');
  }
}

async function physicalOutput(file) {
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('Standalone output files must be regular files');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** Run after the core TypeScript build. The runner is hand-authored separately. */
export async function generateStandalone({ root = repositoryRoot, outputDirectory = join(root, 'standalone/filtering') } = {}) {
  outputDirectory = resolve(outputDirectory);
  const outputs = new Map();
  for (const name of modules) {
    const source = `packages/core/dist/filtering/${name}.js`;
    let code = await readPhysicalSource(root, source);
    code = code.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, '');
    code = code.replace(/(['"])\.\/([a-z-]+)\.js\1/g, '$1./$2.mjs$1');
    // Reject accidental runtime dependencies when the shared filter changes.
    const imports = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g)];
    for (const [, , specifier] of imports) {
      if (!(specifier.startsWith('node:') && isBuiltin(specifier)) && !modules.some(module => specifier === `./${module}.mjs`)) {
        throw new Error(`Standalone filter has an unsupported import in ${source}`);
      }
    }
    outputs.set(`${name}.mjs`, `// Generated from ${source} by scripts/build-standalone-filter.mjs; do not edit.\n${code.trimEnd()}\n`);
  }
  outputs.set('LICENSE', await readPhysicalSource(root, 'LICENSE'));
  await physicalDirectory(outputDirectory);
  // Check every destination before changing any generated output.
  for (const name of outputs.keys()) await physicalOutput(join(outputDirectory, name));
  for (const [name, content] of outputs) {
    const target = join(outputDirectory, name);
    const temporary = join(outputDirectory, `.${name}.${randomUUID()}.tmp`);
    let pending = true;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { await file.writeFile(content, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await physicalDirectory(outputDirectory);
      await physicalOutput(target);
      await rename(temporary, target);
      pending = false;
    } finally {
      if (pending) await unlink(temporary).catch(() => undefined);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/build-standalone-filter.mjs');
  await generateStandalone();
}
