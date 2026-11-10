// Runs after astro build. Every internal link and #anchor in the built HTML
// must point at a page or element that exists, so a renamed page or heading
// fails the build instead of shipping a dead link.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

async function htmlFiles() {
  const files = await readdir(dist, { recursive: true });
  return files.filter((file) => file.endsWith('.html')).map((file) => file.split(path.sep).join('/'));
}

// "start/install/index.html" is served at "/start/install/".
function routeFor(file) {
  return `/${file.replace(/index\.html$/, '').replace(/\.html$/, '/')}`;
}

const pages = new Map();
for (const file of await htmlFiles()) {
  const html = await readFile(path.join(dist, file), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  pages.set(routeFor(file), { file, html, ids });
}

async function exists(target) {
  try {
    await stat(path.join(dist, decodeURIComponent(target)));
    return true;
  } catch {
    return false;
  }
}

const problems = [];
for (const [route, page] of pages) {
  for (const [, href] of page.html.matchAll(/\shref="([^"]+)"/g)) {
    if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue; // External, mailto and similar.

    const [rawPath, anchor] = href.split('#');
    const target = rawPath ? new URL(rawPath, `https://site${route}`).pathname : route;
    const linked = pages.get(target.endsWith('/') ? target : `${target}/`) ?? pages.get(target);

    if (!linked && !(await exists(target))) {
      problems.push(`${route}: missing page ${href}`);
    } else if (anchor && linked && !linked.ids.has(decodeURIComponent(anchor))) {
      problems.push(`${route}: missing anchor ${href}`);
    }
  }
}

if (problems.length) {
  console.error(`Link check failed:\n${[...new Set(problems)].join('\n')}`);
  process.exit(1);
}
console.log(`Link check passed for ${pages.size} pages.`);
