#!/usr/bin/env node
// Runs the CI checks on this Mac, for the macOS jobs that CI no longer runs.
//
//   npm run check:mac                 check the current commit
//   npm run check:mac -- --report     also post the results as commit statuses
//   npm run check:mac -- --node /path/to/node   use a specific Node (repeatable)
//
// The current commit is cloned into a temporary folder, so uncommitted changes
// never affect the result. Each Node version gets its own clean install.
// --report posts "local/macos (Node <major>)" statuses to GitHub with the gh
// CLI; the branch ruleset requires the Node 24 one before merging into main.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const MAJORS = [24, 26];
const STEPS = [
  ['Install locked dependencies without lifecycle scripts', 'npm', ['ci', '--ignore-scripts']],
  ['Typecheck, mocked tests, and build', 'npm', ['run', 'check']],
  ["Install the documentation site's locked dependencies", 'npm', ['ci', '--ignore-scripts', '--prefix', 'site']],
  ['Build the documentation site', 'npm', ['run', 'docs:build']],
  ['Verify committed standalone filters match the shared build', 'git', ['diff', '--exit-code', '--', 'standalone/filtering']],
  ['Prepare local CLI release artifacts', 'npm', ['run', 'release:prepare']],
];

const args = process.argv.slice(2);
const report = args.includes('--report');
const keep = args.includes('--keep');
const chosen = args.flatMap((arg, index) => (arg === '--node' ? [args[index + 1]] : []));
const unknown = args.filter((arg, index) => !['--report', '--keep', '--node'].includes(arg) && args[index - 1] !== '--node');
if (unknown.length) fail(`Unknown option ${unknown[0]}. Use --report, --keep or --node <path>.`);

function fail(message) {
  console.error(`check:mac: ${message}`);
  process.exit(2);
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function git(...gitArgs) {
  const result = run('git', gitArgs, { cwd: repository });
  if (result.status !== 0) fail(`git ${gitArgs.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function versionOf(binary) {
  const result = run(binary, ['--version']);
  const match = /^v(\d+)\.\d+\.\d+/.exec(result.stdout.trim());
  return result.status === 0 && match ? { binary, version: result.stdout.trim(), major: Number(match[1]) } : undefined;
}

/** Node binaries from the PATH, nvm and Homebrew; the newest of each wanted major. */
function findNodes() {
  const candidates = new Set();
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) candidates.add(path.join(folder, 'node'));
  const nvm = path.join(process.env.NVM_DIR ?? path.join(os.homedir(), '.nvm'), 'versions', 'node');
  if (existsSync(nvm)) for (const version of readdirSync(nvm)) candidates.add(path.join(nvm, version, 'bin', 'node'));
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    candidates.add(path.join(prefix, 'bin', 'node'));
    for (const major of MAJORS) candidates.add(path.join(prefix, 'opt', `node@${major}`, 'bin', 'node'));
  }
  const found = new Map();
  for (const binary of candidates) {
    if (!existsSync(binary)) continue;
    const node = versionOf(binary);
    if (!node || !MAJORS.includes(node.major)) continue;
    const current = found.get(node.major);
    const newer = !current || node.version.localeCompare(current.version, undefined, { numeric: true }) > 0;
    if (newer) found.set(node.major, node);
  }
  return MAJORS.map((major) => found.get(major)).filter(Boolean);
}

if (process.platform !== 'darwin') fail('This runs the macOS checks, so it needs a Mac. Linux is covered by CI.');
const nodes = chosen.length ? chosen.map((binary) => versionOf(binary) ?? fail(`${binary} is not a working Node binary.`)) : findNodes();
if (!nodes.length) fail(`No Node ${MAJORS.join(' or ')} found. Install one, or pass --node <path>.`);
const missing = MAJORS.filter((major) => !nodes.some((node) => node.major === major));

const sha = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no');
let target;
if (report) {
  if (dirty) fail('Commit or stash your changes first. --report records a result for the pushed commit only.');
  git('fetch', '--quiet', 'origin');
  if (!git('branch', '--remotes', '--contains', sha)) fail(`Push ${sha.slice(0, 7)} first, so the statuses attach to a commit GitHub knows.`);
  const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: repository });
  if (repo.status !== 0) fail('The gh CLI is needed for --report. Run gh auth login first.');
  target = repo.stdout.trim();
}

console.log(`Checking ${sha.slice(0, 7)} on ${nodes.map((node) => `Node ${node.version}`).join(' and ')}.`);
if (dirty) console.log('Uncommitted changes are not included; this checks the last commit.');
if (missing.length) console.log(`Node ${missing.join(', ')} was not found and is skipped.`);

const workspace = await mkdtemp(path.join(os.tmpdir(), 'fonn-check-mac-'));
const results = [];
try {
  for (const node of nodes) {
    const folder = path.join(workspace, `node-${node.major}`);
    const clone = run('git', ['clone', '--quiet', '--no-hardlinks', repository, folder]);
    if (clone.status !== 0) fail(`Could not clone the repository: ${clone.stderr.trim()}`);
    run('git', ['checkout', '--quiet', '--detach', sha], { cwd: folder });
    // The matching npm sits next to each node binary.
    const env = { ...process.env, PATH: `${path.dirname(node.binary)}${path.delimiter}${process.env.PATH ?? ''}`, CI: 'true' };
    const log = [];
    const started = Date.now();
    let failed;
    for (const [name, command, commandArgs] of STEPS) {
      process.stdout.write(`  Node ${node.major}: ${name}… `);
      const result = run(command, commandArgs, { cwd: folder, env });
      log.push(`## ${name}\n$ ${command} ${commandArgs.join(' ')}\n${result.stdout}${result.stderr}`);
      if (result.status !== 0) {
        console.log('failed');
        failed = name;
        break;
      }
      console.log('ok');
    }
    const logFile = path.join(workspace, `node-${node.major}.log`);
    await writeFile(logFile, log.join('\n'));
    const seconds = Math.round((Date.now() - started) / 1000);
    results.push({ node, failed, seconds, logFile });
    if (failed) console.log(`\n${log.at(-1).split('\n').slice(-40).join('\n')}\n`);
  }
} finally {
  if (!keep && results.every((result) => !result.failed)) await rm(workspace, { recursive: true, force: true });
}

console.log('');
for (const { node, failed, seconds } of results) console.log(`${failed ? 'FAIL' : 'PASS'}  Node ${node.version}  ${failed ? `at "${failed}"` : `all ${STEPS.length} steps`}  (${seconds}s)`);
if (results.some((result) => result.failed)) console.log(`Logs are kept in ${workspace}. Delete the folder when you are done.`);

if (report) {
  for (const { node, failed, seconds } of results) {
    const description = failed ? `Failed at: ${failed}`.slice(0, 140) : `Passed on Node ${node.version} in ${seconds}s`;
    const posted = run('gh', ['api', `repos/${target}/statuses/${sha}`, '-f', `state=${failed ? 'failure' : 'success'}`, '-f', `context=local/macos (Node ${node.major})`, '-f', `description=${description}`]);
    console.log(posted.status === 0 ? `Reported local/macos (Node ${node.major}) on ${sha.slice(0, 7)}.` : `Could not report Node ${node.major}: ${posted.stderr.trim()}`);
  }
}
process.exit(results.some((result) => result.failed) ? 1 : 0);
