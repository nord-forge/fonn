// Local preview for the docs site. Builds once, serves site/dist on loopback
// and rebuilds when site/src changes. Uses Node built-ins only.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'site/dist');
const port = Number(process.env.PORT ?? 4321);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function build() {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/docs/build.mjs')], { cwd: root, stdio: 'inherit' });
  return result.status === 0;
}

if (!build()) process.exit(1);

let timer;
watch(path.join(root, 'site/src'), () => {
  clearTimeout(timer);
  timer = setTimeout(build, 120);
});

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Docs preview at http://127.0.0.1:${port}/ (Ctrl+C to stop)`));
