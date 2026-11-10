// Runs before every site build and dev server start.
//
// 1. Copies the Markdown guides from ../docs into the site's "Reference"
//    section, so docs/ stays the single source. Links between guides become
//    site links, and links to other repository files point at GitHub.
// 2. Runs every visualiser sample through the compiled filter at each level,
//    and stops the build when a result no longer matches what the page says.
//
// The compiled core must exist first: npm run docs:build compiles it.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const site = fileURLToPath(new URL('../', import.meta.url));
const repository = path.join(site, '..');
const output = path.join(site, 'src/content/docs/reference');
const GITHUB = 'https://github.com/nord-forge/fonn';

// Guides published under /reference/, in sidebar order.
const GUIDES = ['filtering', 'local-filtering', 'profiles', 'subagents', 'codex', 'billing', 'mcp-output', 'architecture', 'distribution'];

function rewriteLink(target) {
  if (/^(?:[a-z]+:|#)/i.test(target)) return target;

  const [file, anchor] = target.split('#');
  const resolved = path.posix.normalize(path.posix.join('docs', file));
  const guide = /^docs\/([a-z-]+)\.md$/.exec(resolved)?.[1];
  const hash = anchor ? `#${anchor}` : '';

  if (guide && GUIDES.includes(guide)) return `/reference/${guide}/${hash}`;
  const kind = path.posix.extname(resolved) ? 'blob' : 'tree';
  return `${GITHUB}/${kind}/main/${resolved}${hash}`;
}

async function syncGuides() {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  for (const [index, name] of GUIDES.entries()) {
    const source = await readFile(path.join(repository, 'docs', `${name}.md`), 'utf8');
    const heading = /^# (.+)$/m.exec(source);
    if (!heading) throw new Error(`docs/${name}.md needs a "# Title" line.`);

    const body = source
      .replace(heading[0], '')
      .replace(/\]\(([^)\s]+)\)/g, (_, target) => `](${rewriteLink(target)})`)
      .trimStart();

    const frontmatter = [
      '---',
      `title: ${JSON.stringify(heading[1])}`,
      `editUrl: ${GITHUB}/edit/main/docs/${name}.md`,
      'sidebar:',
      `  order: ${index + 1}`,
      '---',
      '',
      `:::note[Synced from the repository]\nThis page is generated from [docs/${name}.md](${GITHUB}/blob/main/docs/${name}.md).\n:::`,
      '',
    ].join('\n');

    await writeFile(path.join(output, `${name}.md`), frontmatter + body);
  }
  return GUIDES.length;
}

async function checkSamples() {
  const core = path.join(repository, 'packages/core/dist/filtering/index.js');
  let createOutputFilter;
  try {
    ({ createOutputFilter } = await import(pathToFileURL(core).href));
  } catch (error) {
    throw new Error('Could not load the compiled core. Run npm run docs:build from the repository root, which compiles it first.', { cause: error });
  }
  const { samples } = await import(pathToFileURL(path.join(site, 'src/scripts/visualiser/samples.js')).href);

  for (const sample of samples) {
    for (const level of ['strict', 'standard', 'similar']) {
      const filter = createOutputFilter({
        mode: 'filter',
        level,
        store: { save: async () => ({ id: '3f6c1d2e-8a4b-4c1d-9e2f-5a6b7c8d9e0f' }) },
      });
      const { decision } = await filter.apply({
        toolName: 'Bash',
        toolInput: { command: sample.command },
        response: { stdout: sample.stdout, stderr: '' },
        sessionId: 'docs',
        toolUseId: 'docs',
      });
      if (decision.reason !== sample.levels[level]) {
        throw new Error(`Sample "${sample.id}" at the ${level} level expected ${sample.levels[level]} but the filter returned ${decision.reason}.`);
      }
    }
  }
  return samples.length;
}

const guides = await syncGuides();
const samples = await checkSamples();
console.log(`Synced ${guides} guides from docs/. ${samples} samples matched the compiled filter at every level.`);
