import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaces = ['core', 'cli'];
const forbiddenSegments = /^(?:node_modules|\.git|\.env(?:\..*)?|\.aws|\.claude|\.local|\.cache|tmp|temp|src|tests|fixtures)$/i;

export function validateVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${String(version)}. Use a plain semantic version without a v prefix.`);
  }
  return version;
}

async function checkedPath(root, relative) {
  const base = await realpath(root);
  let current = base;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('Unsafe payload path.');
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in release payload paths: ${relative}`);
  }
  return current;
}

async function json(root, path) { return JSON.parse(await readFile(await checkedPath(root, path), 'utf8')); }

export async function collectPayload(root) {
  const manifest = await json(root, 'package.json');
  const version = validateVersion(manifest.version);
  const manifests = [manifest];
  for (const name of workspaces) {
    const pkg = await json(root, `packages/${name}/package.json`);
    if (pkg.name !== `@nord-forge/fonn-${name}` || pkg.version !== version) {
      throw new Error(`packages/${name}/package.json must use @nord-forge/fonn-${name} version ${version}.`);
    }
    manifests.push(pkg);
  }
  const lock = await json(root, 'package-lock.json');
  for (const name of workspaces) {
    const entry = lock.packages?.[`node_modules/@nord-forge/fonn-${name}`];
    if (!entry?.link || entry.resolved !== `packages/${name}`) {
      throw new Error(`Regenerate package-lock.json with npm install: ${name} must resolve to its local workspace, not an unpublished registry package.`);
    }
  }
  for (const [dependency, pinned] of [['@anthropic-ai/claude-agent-sdk', '0.3.321'], ['zod', '4.1.12']]) {
    const versions = manifests.map(pkg => pkg.dependencies?.[dependency]).filter(Boolean);
    if (!versions.length || versions.some(value => value !== pinned)) throw new Error(`${dependency} must be pinned to ${pinned}.`);
  }
  const entries = [];
  async function add(relative) {
    const physical = await checkedPath(root, relative);
    const stat = await lstat(physical);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release payload requires a regular file: ${relative}`);
    entries.push({ path: `fonn/${relative}`, data: await readFile(physical), mode: 0o644 });
  }
  async function built(relative) {
    let children;
    try { children = await readdir(await checkedPath(root, relative), { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Missing build output ${relative}. Run npm run build before npm run release:prepare.`);
      throw error;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (forbiddenSegments.test(child.name) || child.name.startsWith('.')) continue;
      const path = `${relative}/${child.name}`;
      if (child.isSymbolicLink()) throw new Error(`Symlinks are not allowed in release build output: ${path}`);
      if (child.isDirectory()) await built(path);
      else if (/\.(?:js|mjs|cjs|json)$/.test(child.name)) await add(path);
    }
  }
  for (const name of workspaces) {
    await add(`packages/${name}/package.json`);
    await built(`packages/${name}/dist`);
  }
  if (!entries.some(entry => entry.path === 'fonn/packages/cli/dist/cli/main.js')) {
    throw new Error('Missing build output packages/cli/dist/cli/main.js. Run npm run build before npm run release:prepare.');
  }
  if (!entries.some(entry => entry.path.startsWith('fonn/packages/core/dist/') && entry.path.endsWith('.js'))) {
    throw new Error('Missing JavaScript build output packages/core/dist. Run npm run build before npm run release:prepare.');
  }
  // Include the local development entrypoint when the build emits it.
  if (await lstat(join(root, 'dist')).catch(() => null)) await built('dist');
  for (const file of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'packaging/homebrew/runtime.mjs', 'packaging/homebrew/launcher.mjs']) await add(file);
  for (const file of (await readdir(root)).sort()) {
    if (/^(?:NOTICE|NOTICES|THIRD[-_]PARTY[-_]NOTICES)(?:\.(?:md|txt))?$/i.test(file)) await add(file);
  }
  entries.push({ path: 'fonn/.fonn-release.json', data: Buffer.from(`${JSON.stringify({ format: 1, name: 'fonn', version })}\n`), mode: 0o644 });
  return { version, entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

function tarHeader(path, size, mode, directory) {
  const header = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const boundary = path.lastIndexOf('/', 155);
    prefix = path.slice(0, boundary);
    name = path.slice(boundary + 1);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Archive path is too long: ${path}`);
  const text = (value, offset, length) => header.write(value, offset, length, 'utf8');
  const octal = (value, offset, length) => text(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
  text(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(size, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156);
  text(directory ? '5' : '0', 156, 1); text('ustar\0', 257, 6); text('00', 263, 2); text(prefix, 345, 155);
  const sum = header.reduce((total, byte) => total + byte, 0);
  text(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

export function createArchive(entries) {
  const directories = new Set(['fonn']);
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.split('/').some(part => part === '..')) throw new Error('Unsafe archive path.');
    for (let path = posix.dirname(entry.path); path !== '.'; path = posix.dirname(path)) directories.add(path);
  }
  const all = [...[...directories].map(path => ({ path: `${path}/`, data: Buffer.alloc(0), mode: 0o755, directory: true })), ...entries]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const parts = [];
  for (const entry of all) {
    parts.push(tarHeader(entry.path, entry.data.length, entry.mode ?? 0o644, entry.directory), entry.data);
    const padding = (512 - entry.data.length % 512) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export function renderCask(template, version, sha256) {
  validateVersion(version);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Cask requires an actual SHA256 checksum.');
  if (!template.includes('@VERSION@') || !template.includes('@SHA256@')) throw new Error('Cask template placeholders are missing.');
  return template.replaceAll('@VERSION@', version).replaceAll('@SHA256@', sha256);
}

export async function prepareRelease({ root = repositoryRoot, outputDirectory = join(root, '.release') } = {}) {
  const { version, entries } = await collectPayload(root);
  const archive = createArchive(entries);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const filename = `fonn-${version}.tar.gz`;
  const cask = renderCask(await readFile(await checkedPath(root, 'packaging/homebrew/fonn.rb.template'), 'utf8'), version, sha256);
  await mkdir(join(outputDirectory, 'Casks'), { recursive: true });
  await writeFile(join(outputDirectory, filename), archive);
  await writeFile(join(outputDirectory, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
  await writeFile(join(outputDirectory, 'Casks/fonn.rb'), cask);
  return { archive: join(outputDirectory, filename), checksums: join(outputDirectory, 'SHA256SUMS'), cask: join(outputDirectory, 'Casks/fonn.rb'), sha256, version };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length && !(args.length === 2 && args[0] === '--output-dir')) throw new Error('Usage: node scripts/release/prepare.mjs [--output-dir /path/to/output]');
  const result = await prepareRelease({ outputDirectory: args.length ? resolve(args[1]) : undefined });
  console.log(`Prepared ${result.archive}\nSHA256 ${result.sha256}\nCask ${result.cask}`);
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
