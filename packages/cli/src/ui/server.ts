// The fonn ui HTTP server. It listens on 127.0.0.1 only, serves the bundled
// web interface and a JSON API, and follows the security model in
// contract.ts: a per-start token exchanged for a cookie, a Host allow-list
// against DNS rebinding and same-origin checks. Changes also need a matching
// Origin, a JSON content type, the X-Fonn-Request header and a small body.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FolderPicked, FolderPickerInfo } from './contract.js';
import { pickerCommand, systemFolderPicker, type FolderPicker } from './folder-picker.js';
import { uiAssets } from './assets.generated.js';
import {
  getHooks, getHookPlan, postHookApply, type UiHooks,
  ApiFailure, DEFAULT_SLICE, deleteLaunch, deleteProfile, getArtifact, getGlobalSettings, getInstruction, getLaunch, getLaunches,
  getOverview, getSession, getProfiles, getProject, getProjects, getRuns, postFilterTest, postRecordsCleanup, postProfile, putGlobalRules, putGlobalSetting,
  putProfile, putProjectSettings, putRulesApproval, type UiDirectories,
} from './api.js';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
// The test bench accepts up to 200,000 characters of output, which JSON escaping can roughly double.
const TEST_BENCH_BODY_BYTES = 512 * 1024;
// Past this, an oversized body is no longer drained and the connection is dropped.
const MAX_DRAIN_BYTES = 1024 * 1024;
const READ_METHODS = ['GET', 'HEAD'] as const;
const CHANGE_METHODS = new Set(['POST', 'PUT', 'DELETE']);

export interface UiServerOptions extends UiDirectories {
  /** 0 or omitted picks a random free port. */
  port?: number;
  /** Tests may pass a fixed token. A random 32-byte token is used otherwise. */
  token?: string;
  /** Tests pass their own picker, or null for none. Otherwise the system dialog is used where one exists. */
  folderPicker?: FolderPicker | null;
  /** Tests supply an offline hook implementation. */
  hooks?: UiHooks;
}

/** One folder dialog at a time; a second request while it is open gets a 409. */
interface PickerState {
  picker: Promise<FolderPicker | null>;
  open: boolean;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // frame-ancestors stops other pages from embedding the UI (clickjacking).
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
});

const SESSION_EXPIRED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fonn</title></head>
<body><main><h1>This session has ended</h1><p>Each start of fonn ui uses a new link. Run <code>fonn ui</code> again and open the link it prints.</p></main></body></html>`;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares fixed-length digests, so neither content nor length leaks through timing. */
function sameToken(candidate: string | undefined, token: string): boolean {
  return candidate !== undefined && timingSafeEqual(digest(candidate), digest(token));
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function bearer(request: IncomingMessage): string | undefined {
  const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
  return match?.[1];
}

function send(response: ServerResponse, status: number, body: string, contentType: string, extra: Record<string, string> = {}): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), ...extra });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8', extra);
}

function sendError(response: ServerResponse, status: number, message: string, extra?: Record<string, string>): void {
  sendJson(response, status, { error: message }, extra);
}

function integerParameter(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^\d{1,15}$/.test(value)) throw new ApiFailure(400, `The ${name} must be a whole number.`);
  return Number(value);
}

type Handler = (body: unknown) => Promise<unknown>;
type Methods = Partial<Record<'GET' | 'POST' | 'PUT' | 'DELETE', Handler>>;

function pathSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new ApiFailure(400, 'Bad request.'); }
}

/** The handlers for one API path, keyed by method. Undefined for unknown paths. */
function route(directories: UiDirectories, url: URL, folders: PickerState, hooks: () => Promise<UiHooks>): Methods | undefined {
  const root = url.searchParams.get('root');
  switch (url.pathname) {
    case '/api/pick-folder': return {
      GET: async (): Promise<FolderPickerInfo> => ({ supported: (await folders.picker) !== null }),
      POST: async (): Promise<FolderPicked> => {
        const picker = await folders.picker;
        if (!picker) throw new ApiFailure(404, 'No folder picker is available on this system. Type the path instead.');
        if (folders.open) throw new ApiFailure(409, 'A folder picker is already open. Finish or cancel it first.');
        folders.open = true;
        try { return { path: await picker() }; }
        finally { folders.open = false; }
      },
    };
    case '/api/session': return { GET: async () => getSession() };
    case '/api/hooks': return { GET: async () => getHooks(directories, await hooks()) };
    case '/api/overview': return { GET: () => getOverview(directories) };
    case '/api/profiles': return { GET: () => getProfiles(directories), POST: (body) => postProfile(directories, body) };
    case '/api/settings/global': return { GET: () => getGlobalSettings(directories), PUT: (body) => putGlobalSetting(directories, body) };
    case '/api/settings/global/rules': return { PUT: (body) => putGlobalRules(directories, body) };
    case '/api/projects': return { GET: () => getProjects(directories) };
    case '/api/project': return { GET: () => getProject(directories, root) };
    case '/api/project/settings': return { PUT: (body) => putProjectSettings(directories, body) };
    case '/api/project/rules-approval': return { PUT: (body) => putRulesApproval(directories, body) };
    case '/api/project/instructions': return { GET: () => getInstruction(directories, root, url.searchParams.get('name')) };
    case '/api/launches': return { GET: () => getLaunches(directories, root) };
    case '/api/runs': return { GET: () => getRuns(directories, root) };
    case '/api/filter/test': return { POST: (body) => postFilterTest(directories, body) };
    case '/api/records/cleanup': return { POST: (body) => postRecordsCleanup(directories, body) };
  }
  const hook = /^\/api\/hooks\/([^/]+)\/(plan|apply)$/.exec(url.pathname);
  if (hook) {
    const agent = pathSegment(hook[1]!);
    return hook[2] === 'plan'
      ? { GET: async () => getHookPlan(directories, await hooks(), agent, url.searchParams.get('action')) }
      : { POST: async (body) => postHookApply(directories, await hooks(), agent, body) };
  }
  const profile = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
  if (profile) {
    return {
      PUT: (body) => putProfile(directories, pathSegment(profile[1]!), body),
      DELETE: () => deleteProfile(directories, pathSegment(profile[1]!)),
    };
  }
  const launch = /^\/api\/launches\/([^/]+)$/.exec(url.pathname);
  if (launch) return { GET: () => getLaunch(directories, launch[1]!), DELETE: () => deleteLaunch(directories, launch[1]!, url.searchParams.get('confirm') === 'running') };
  const artifact = /^\/api\/launches\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (artifact) {
    return { GET: () => getArtifact(directories, artifact[1]!, artifact[2]!, integerParameter(url, 'offset', 0), integerParameter(url, 'limit', DEFAULT_SLICE)) };
  }
  return undefined;
}

function allowedMethods(methods: Methods | undefined): string[] {
  if (!methods) return [...READ_METHODS];
  return Object.keys(methods).flatMap((method) => (method === 'GET' ? [...READ_METHODS] : [method]));
}

/** Reads a JSON body up to `limit` bytes without buffering more. Undefined when the body is empty. */
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const tooLarge = () => new ApiFailure(413, `The request body is larger than ${Math.round(limit / 1024)} KB.`);
  if (Number(request.headers['content-length'] ?? 0) > limit) throw tooLarge();
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      if (length <= limit) return void chunks.push(chunk);
      // Stop collecting; the caller drains the rest so the 413 still reaches the client.
      request.off('data', onData);
      request.pause();
      reject(tooLarge());
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiFailure(400, 'The request body is not valid JSON.');
  }
}

/**
 * Throws away the rest of a refused body before answering. Closing the
 * connection while the client is still sending makes it fail with a broken
 * pipe instead of reading the 413. Past MAX_DRAIN_BYTES the request is dropped.
 */
function drain(request: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (request.readableEnded) return resolve();
    let length = 0;
    request.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_DRAIN_BYTES) {
        request.destroy();
        resolve();
      }
    });
    request.once('end', () => resolve());
    request.once('close', () => resolve());
    request.resume();
  });
}

async function serveApi(handler: Handler | undefined, request: IncomingMessage, response: ServerResponse, limit: number): Promise<void> {
  if (!handler) return sendError(response, 404, 'Not found.');
  try {
    const body = CHANGE_METHODS.has(request.method ?? '') ? await readBody(request, limit) : undefined;
    sendJson(response, 200, await handler(body));
  } catch (error) {
    if (error instanceof ApiFailure) {
      if (error.status === 413) await drain(request);
      return sendError(response, error.status, error.message, error.status === 413 ? { Connection: 'close' } : undefined);
    }
    // Unexpected failures can carry paths or record contents, so the details stay local.
    sendError(response, 500, 'The request could not be completed.');
  }
}

/** The extra checks every change must pass, on top of the session. */
function changeAllowed(request: IncomingMessage, origin: string): boolean {
  const contentType = (request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
  return request.headers.origin === origin && request.headers['x-fonn-request'] === '1' && contentType === 'application/json';
}

function serveAsset(url: URL, response: ServerResponse): void {
  const asset = uiAssets[url.pathname === '/' ? '/index.html' : url.pathname];
  if (!asset) return sendError(response, 404, 'Not found.');
  send(response, 200, asset.body, asset.contentType);
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const directories: UiDirectories = { configDirectory: options.configDirectory, stateDirectory: options.stateDirectory };
  const folders: PickerState = {
    picker: options.folderPicker !== undefined
      ? Promise.resolve(options.folderPicker)
      : pickerCommand().then((command) => (command ? systemFolderPicker(command) : null)),
    open: false,
  };
  const hooks = async (): Promise<UiHooks> => options.hooks ?? await import('../hooks/index.js');
  let port = 0;
  // Cookies are not separated by port, so each server gets its own name.
  const cookieName = () => `fonn_ui_${port}`;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const allowedHosts = [`${HOST}:${port}`, `localhost:${port}`];
    const host = request.headers.host ?? '';
    if (!allowedHosts.includes(host)) return sendError(response, 403, 'Forbidden.');
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return sendError(response, 403, 'Forbidden.');
    if (!request.url?.startsWith('/')) return sendError(response, 400, 'Bad request.');
    const url = new URL(request.url, `http://${host}`);
    const methods = url.pathname.startsWith('/api/') ? route(directories, url, folders, hooks) : undefined;
    const allowed = allowedMethods(methods);
    const method = request.method ?? '';
    if (!allowed.includes(method)) return sendError(response, 405, 'Method not allowed.', { Allow: allowed.join(', ') });

    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (!sameToken(url.searchParams.get('token') ?? undefined, token)) return sendError(response, 401, 'Unauthorized.');
      return send(response, 303, '', 'text/plain; charset=utf-8', {
        Location: '/',
        'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    if (!sameToken(cookieValue(request, cookieName()), token) && !sameToken(bearer(request), token)) {
      // A browser tab left open after a restart gets a readable page instead of JSON.
      if (!url.pathname.startsWith('/api/')) return send(response, 401, SESSION_EXPIRED_PAGE, 'text/html; charset=utf-8');
      return sendError(response, 401, 'Unauthorized.');
    }

    if (CHANGE_METHODS.has(method) && !changeAllowed(request, `http://${host}`)) return sendError(response, 403, 'Forbidden.');
    if (url.pathname.startsWith('/api/')) {
      const handler = methods?.[method === 'HEAD' ? 'GET' : method as keyof Methods];
      return serveApi(handler, request, response, url.pathname === '/api/filter/test' ? TEST_BENCH_BODY_BYTES : MAX_BODY_BYTES);
    }
    serveAsset(url, response);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) sendError(response, 500, 'The request could not be completed.');
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, HOST, () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST}:${port}/?token=${token}`,
    port,
    token,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}
