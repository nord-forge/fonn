// Builds the static documentation site from site/src into site/dist.
// The profile table, the filtering demo and the visualiser all use the compiled
// core, so run `npm run build --workspace @nord-forge/fonn-core` first
// (`npm run docs:build` does this).
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, 'site/src');
const output = path.join(root, 'site/dist');
const coreFiltering = path.join(root, 'packages/core/dist/filtering');

async function importFrom(file) {
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Could not load ${path.relative(root, file)}. Run npm run docs:build, which compiles the core first.`, { cause: error });
  }
}

const { profiles, getProfile } = await importFrom(path.join(root, 'packages/core/dist/profiles.js'));
const { createOutputFilter } = await importFrom(path.join(coreFiltering, 'index.js'));
const { samples } = await importFrom(path.join(source, 'samples.js'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = (value) => value.toLocaleString('en-US');

function requirementFor(profile) {
  if ((profile.provider ?? 'claude') === 'codex') return 'Codex CLI 0.167.0+';
  if (/^claude-(?:fable|mythos)-/.test(profile.model)) {
    const verified = profile.model.startsWith('claude-mythos-') ? ', eligible verified account' : '';
    return `Claude Code 2.1.321+ and account access${verified}`;
  }
  return 'Claude Code 2.1.319+';
}

function profileRows() {
  const initial = getProfile().name;
  return Object.values(profiles).map((profile) => {
    const provider = profile.provider ?? 'claude';
    const notes = [];
    if (profile.name === initial) notes.push('Initial default');
    if (profile.name === 'codex:sol-medium') notes.push('Codex default');
    const badge = notes.map((note) => ` <span class="tag">${escape(note)}</span>`).join('');
    return `<tr><th scope="row"><code>${escape(profile.name)}</code>${badge}</th>`
      + `<td>${provider === 'codex' ? 'Codex' : 'Claude'}</td>`
      + `<td><code>${escape(profile.model)}</code></td>`
      + `<td>${escape(profile.effort)}</td>`
      + `<td>${escape(requirementFor(profile))}</td></tr>`;
  }).join('\n');
}

async function runFilter(sample, level = 'standard') {
  const filter = createOutputFilter({
    mode: 'filter', level,
    store: { save: async () => ({ id: '3f6c1d2e-8a4b-4c1d-9e2f-5a6b7c8d9e0f' }) },
    recoveryHint: (id) => `Recover the original tool response with: fonn native-output <launch-id> ${id}`,
  });
  const { response, decision } = await filter.apply({
    toolName: 'Bash', toolInput: { command: sample.command }, response: { stdout: sample.stdout, stderr: '' },
    sessionId: 'docs-sample', toolUseId: 'docs-sample',
  });
  return { delivered: response.stdout, decision };
}

// Every sample must still produce the decision the visualiser describes.
const results = new Map();
const similarResults = new Map();
for (const sample of samples) {
  const result = await runFilter(sample);
  if (result.decision.reason !== sample.expect) {
    throw new Error(`Sample ${sample.id} expected ${sample.expect} but the filter returned ${result.decision.reason}.`);
  }
  for (const level of ['strict', 'similar']) {
    const other = await runFilter(sample, level);
    if (other.decision.reason !== sample.levels[level]) {
      throw new Error(`Sample ${sample.id} at the ${level} level expected ${sample.levels[level]} but the filter returned ${other.decision.reason}.`);
    }
    if (level === 'similar') similarResults.set(sample.id, other);
  }
  if (sample.expect === 'safe_reduction' && /FAILURES!|\[ERROR\]|WARN/.test(sample.stdout)) {
    for (const marker of ['FAILURES!', '[ERROR]', 'WARN']) {
      if (sample.stdout.includes(marker) && !result.delivered.includes(marker)) throw new Error(`Sample ${sample.id} lost ${marker}.`);
    }
  }
  results.set(sample.id, result);
}

const php = results.get('phpunit');
const phpSample = samples.find((sample) => sample.id === 'phpunit');
const heartbeat = samples.find((sample) => sample.id === 'heartbeat');
const removedPercent = Math.round((1 - php.decision.deliveredCharacters / php.decision.originalCharacters) * 100);
const replacements = {
  version: escape(manifest.version),
  profiles: profileRows(),
  'phpunit-original': escape(phpSample.stdout.trimEnd()),
  'phpunit-filtered': escape(php.delivered.trimEnd()),
  'phpunit-stats': `${number(php.decision.originalCharacters)} characters in, ${number(php.decision.deliveredCharacters)} delivered, ${number(php.decision.removedLines)} progress rows removed. That is ${removedPercent}% fewer characters for this sample only.`,
  'heartbeat-original': escape(heartbeat.stdout.trimEnd()),
  'heartbeat-stats': `${number(heartbeat.stdout.length)} characters in, ${number(heartbeat.stdout.length)} delivered. No two adjacent lines are identical, so the standard level changes nothing.`,
  'heartbeat-similar': escape(similarResults.get('heartbeat').delivered.trimEnd()),
  'heartbeat-similar-stats': `${number(similarResults.get('heartbeat').decision.originalCharacters)} characters in, ${number(similarResults.get('heartbeat').decision.deliveredCharacters)} delivered, ${number(similarResults.get('heartbeat').decision.removedLines)} similar lines removed. Sample only.`,
  'repeated-original': escape(samples.find((sample) => sample.id === 'repeated').stdout.trimEnd()),
  'repeated-filtered': escape(results.get('repeated').delivered.trimEnd()),
  'repeated-stats': `${number(results.get('repeated').decision.originalCharacters)} characters in, ${number(results.get('repeated').decision.deliveredCharacters)} delivered, ${number(results.get('repeated').decision.removedLines)} duplicate lines removed. Sample only.`,
};

// Stylesheet parts live in site/src/styles. main.css lists them with @import,
// and the build inlines them in that order into one styles.css.
async function bundleStyles() {
  const directory = path.join(source, 'styles');
  const main = await readFile(path.join(directory, 'main.css'), 'utf8');
  const parts = [];
  for (const [, name] of main.matchAll(/^@import "([a-z-]+\.css)";$/gm)) {
    parts.push(`/* ${name} */\n${(await readFile(path.join(directory, name), 'utf8')).trim()}\n`);
  }
  const listed = new Set([...main.matchAll(/^@import "([a-z-]+\.css)";$/gm)].map((m) => m[1]));
  const unlisted = (await readdir(directory)).filter((file) => file.endsWith('.css') && file !== 'main.css' && !listed.has(file));
  if (unlisted.length) throw new Error(`Stylesheet parts missing from styles/main.css: ${unlisted.join(', ')}`);
  return parts.join('\n');
}

const entries = (await readdir(source, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
const pages = entries.filter((file) => file.endsWith('.html'));
const rendered = new Map();
for (const page of pages) {
  const html = (await readFile(path.join(source, page), 'utf8')).replace(/\{\{\s*([a-z-]+)\s*\}\}/g, (match, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`Unknown placeholder ${match} in site/src/${page}`);
    return replacements[key];
  });
  rendered.set(page, html);
}

// Small structural checks instead of a test suite: in-page and cross-page
// anchors, plus every local asset the pages reference, must exist.
const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const assets = new Set([...entries, 'styles.css', 'filter/index.js', 'filter/adapters.js', 'filter/artifact-store.js']);
const problems = [];
for (const [page, html] of rendered) {
  for (const [, target] of html.matchAll(/(?:src|href)="(?!https?:|mailto:)([^"]*)"/g)) {
    const [file, anchor] = target.split('#');
    const resolved = file ? file.replace(/^\.\//, '') : page;
    if (file && !assets.has(resolved)) problems.push(`${page}: missing asset ${target}`);
    else if (anchor && rendered.has(resolved) && !idsOf(rendered.get(resolved)).has(anchor)) problems.push(`${page}: missing anchor ${target}`);
  }
}
if (problems.length) throw new Error(`Docs site link check failed:\n${problems.join('\n')}`);

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'filter'), { recursive: true });
for (const [page, html] of rendered) await writeFile(path.join(output, page), html);
for (const file of entries) {
  if (file.endsWith('.html') || file.startsWith('.')) continue;
  await copyFile(path.join(source, file), path.join(output, file));
}
await writeFile(path.join(output, 'styles.css'), await bundleStyles());

// The visualiser imports the real compiled filter. Archiving uses Node file
// APIs, so the browser gets a stub store and the page supplies its own.
for (const file of ['index.js', 'adapters.js']) {
  const code = await readFile(path.join(coreFiltering, file), 'utf8');
  await writeFile(path.join(output, 'filter', file), `// Copied from packages/core/dist/filtering/${file} by scripts/docs/build.mjs.\n${code.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n')}`);
}
await writeFile(path.join(output, 'filter/artifact-store.js'), "// Browser stub. The visualiser keeps archived originals in memory.\nexport function createArtifactStore() {\n  throw new Error('The docs site has no file-backed artifact store.');\n}\n");

console.log(`Built ${pages.length} pages into ${path.relative(root, output)}. ${samples.length} samples matched the compiled filter.`);
