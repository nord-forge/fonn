// Builds the docs site on this machine and uploads only the finished output
// to Vercel (a "prebuilt" deployment). Vercel's own Git builds are switched
// off in vercel.json, so this is the only way the site is published.
//
//   npm run docs:deploy              deploy to production
//   npm run docs:deploy -- --preview make a preview deployment instead
//
// Needs the Vercel CLI, signed in with access to the project (vercel login).
// The project and account IDs below are identifiers, not secrets. Passing them
// as environment variables avoids linking this folder with `vercel link`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERCEL_PROJECT_ID = 'prj_diEvpt1an2DhjmUS3cl6Okn6BKiF';
const VERCEL_ORG_ID = 'team_7FaFVZg7ToQUI2WZGAg1QD2g';
const SCOPE = 'nickbevers';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--preview');
if (unknown.length) {
  console.error(`Unknown option ${unknown[0]}. Usage: npm run docs:deploy [-- --preview]`);
  process.exit(2);
}
const production = !args.includes('--preview');
const environment = production ? 'production' : 'preview';
const env = { ...process.env, VERCEL_ORG_ID, VERCEL_PROJECT_ID };

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error?.code === 'ENOENT') {
    console.error(`${command} was not found. Install it first${command === 'vercel' ? ' (npm i -g vercel) and run vercel login' : ''}.`);
    process.exit(1);
  }
  if (result.status !== 0 && !options.allowFailure) {
    console.error(`${command} ${commandArgs.join(' ')} failed.`);
    process.exit(result.status ?? 1);
  }
  return result;
}

// What gets deployed must match what is committed.
const changes = run('git', ['status', '--porcelain', '--untracked-files=no'], { capture: true }).stdout.trim();
if (changes) {
  console.error('Commit or stash your changes first, so the deployment matches a commit:\n' + changes);
  process.exit(1);
}

if (production) {
  const branch = run('git', ['branch', '--show-current'], { capture: true }).stdout.trim();
  run('git', ['fetch', '--quiet', 'origin', 'main'], { allowFailure: true });
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main'], { capture: true, allowFailure: true }).stdout.trim();
  if (branch !== 'main') console.warn(`Warning: deploying branch "${branch}" to production, not main.`);
  if (behind && behind !== '0') console.warn(`Warning: this checkout is ${behind} commit(s) behind origin/main.`);
}

const commit = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true }).stdout.trim();
console.log(`Deploying ${commit} to ${environment}.`);

// 1. Project settings (build command, output directory) from Vercel.
run('vercel', ['pull', '--yes', `--environment=${environment}`, '--scope', SCOPE]);
// 2. Build here. This runs the install and build commands from vercel.json.
run('vercel', ['build', ...(production ? ['--prod'] : []), '--scope', SCOPE]);
// 3. Upload only the finished output in .vercel/output.
run('vercel', ['deploy', '--prebuilt', ...(production ? ['--prod'] : []), '--scope', SCOPE]);
