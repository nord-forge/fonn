// Hides likely secrets in a config file before it is shown. A plan keeps the
// real contents for writing and fingerprints; only the display is redacted.
//
// Text is read like a shell line: quoted strings are opened and masked on
// their own, to a fixed depth, and a secret value is the complete shell word
// after a credential name. Every scan is linear, with no regex backtracking
// over values.
import type { HookAgent } from './contract.js';

const HIDDEN = '[hidden]';
const MAX_DEPTH = 6;

// Names that are or end in one of these hold a credential. Separators are
// ignored, so OPENAI_API_KEY, api-key, apiKey and x.auth.token all count.
const CREDENTIAL_ENDINGS = [
  'token', 'secret', 'password', 'passwd', 'pwd', 'apikey', 'accesskey', 'privatekey', 'clientsecret',
  'authtoken', 'bearer', 'credential', 'credentials', 'sessiontoken', 'cookie',
];
const SECRET_HEADERS = new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'xapikey', 'apikey', 'xauthtoken', 'privatetoken']);

function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, '');
}

/** True for a name that holds a credential, such as GITHUB_TOKEN or --api-key, and not for --keymap or --session-name. */
export function credentialName(name: string): boolean {
  const flat = normalize(name);
  return CREDENTIAL_ENDINGS.some(ending => flat.endsWith(ending));
}

function secretHeader(name: string): boolean {
  return SECRET_HEADERS.has(normalize(name)) || credentialName(name);
}

// Well-known token shapes, hidden wherever they appear.
const TOKEN_SHAPES = /\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{10,})/g;
// user:password@ in a URL. The character classes cannot overlap, so this does not backtrack.
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"']*:)([^\s/@"']+)(@)/gi;

/** End of the double-quoted string whose opening quote is at `start`, or the text length. */
function doubleQuoteEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '"') return index;
  }
  return text.length;
}

/** End (exclusive) of the complete shell word at `start`: quotes and backslash escapes to any depth, up to unquoted space or an operator. */
function wordEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const character = text[index]!;
    if (/[\s;&|)]/.test(character)) break;
    if (character === '\\') index += 2;
    else if (character === "'") { const end = text.indexOf("'", index + 1); index = end < 0 ? text.length : end + 1; }
    else if (character === '"') index = Math.min(text.length, doubleQuoteEnd(text, index) + 1);
    else index++;
  }
  return Math.min(index, text.length);
}

function hiddenWord(word: string): string {
  const quote = word[0] === '"' || word[0] === "'" ? word[0] : '';
  return `${quote}${HIDDEN}${quote}`;
}

function unescapeDouble(raw: string): string {
  return raw.replace(/\\([\\"$`\n])/g, '$1');
}

function escapeDouble(value: string): string {
  return value.replace(/[\\"$`]/g, match => '\\' + match);
}

const FLAG = /--([A-Za-z0-9][\w.-]*)(=|[ \t]+)/y;
const ASSIGNMENT = /(?:export[ \t]+)?([A-Za-z_][\w.-]*)([ \t]*=[ \t]*)/y;
const HEADER = /([A-Za-z][\w-]*)([ \t]*:[ \t]*)((?:bearer|basic|token|digest)[ \t]+)?/iy;

/** A credential site at `index`: the text to keep before the value, or undefined. */
function siteAt(text: string, index: number): string | undefined {
  for (const [pattern, test] of [[FLAG, credentialName], [ASSIGNMENT, credentialName], [HEADER, secretHeader]] as const) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (match && test(match[1]!) && index + match[0].length < text.length) return match[0];
  }
  return undefined;
}

function maskLevel(text: string, depth: number): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close < 0 ? text.length : close;
      const inner = text.slice(index + 1, end);
      // Past the scanning depth, hide the contents rather than show them unread.
      out += "'" + (depth < MAX_DEPTH ? maskLevel(inner, depth + 1) : HIDDEN) + (close < 0 ? '' : "'");
      index = end + 1;
      continue;
    }
    if (character === '"') {
      const close = doubleQuoteEnd(text, index);
      const raw = text.slice(index + 1, close);
      const inner = unescapeDouble(raw);
      const masked = depth < MAX_DEPTH ? maskLevel(inner, depth + 1) : HIDDEN;
      out += '"' + (masked === inner ? raw : escapeDouble(masked)) + (close < text.length ? '"' : '');
      index = close + 1;
      continue;
    }
    if (character === '\\') {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    const boundary = index === 0 || /[\s;&|(]/.test(text[index - 1]!);
    const site = boundary ? siteAt(text, index) : undefined;
    if (site !== undefined) {
      const start = index + site.length;
      const end = wordEnd(text, start);
      if (end > start) {
        out += site + hiddenWord(text.slice(start, end));
        index = end;
        continue;
      }
    }
    out += character;
    index++;
  }
  return out;
}

/** Masks every likely secret in one piece of text. */
export function maskSecrets(text: string): string {
  return maskLevel(text.replace(TOKEN_SHAPES, HIDDEN).replace(URL_PASSWORD, `$1${HIDDEN}$3`), 0);
}

function hideValue(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'number') return HIDDEN;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' || typeof item === 'number' ? HIDDEN : item);
  return value;
}

function redactJson(value: unknown, insideEnv = false): unknown {
  if (typeof value === 'string') return insideEnv ? HIDDEN : maskSecrets(value);
  if (Array.isArray(value)) return value.map(item => redactJson(item, insideEnv));
  if (value === null || typeof value !== 'object') return insideEnv ? hideValue(value) : value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (insideEnv) result[key] = item !== null && typeof item === 'object' ? redactJson(item, true) : hideValue(item);
    else if (key === 'env' && item !== null && typeof item === 'object' && !Array.isArray(item)) result[key] = redactJson(item, true);
    // Keys named like a credential, or like a secret header such as Authorization.
    else if ((credentialName(key) || SECRET_HEADERS.has(normalize(key))) && (typeof item === 'string' || typeof item === 'number' || Array.isArray(item))) result[key] = hideValue(item);
    else result[key] = redactJson(item);
  }
  return result;
}

/**
 * The text to show for a config. JSON configs (Claude, Codex) hide string
 * values under credential names, every value inside an `env` object, and
 * secrets inside any other string. Other text is masked line by line.
 */
export function redactForDisplay(text: string | null, agent: HookAgent): string | null {
  if (text === null) return null;
  if (agent === 'claude' || agent === 'codex') {
    try {
      const parsed: unknown = JSON.parse(text);
      const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';
      return JSON.stringify(redactJson(parsed), null, indent) + (text.endsWith('\n') ? '\n' : '');
    } catch { /* not JSON: mask it as text */ }
  }
  return text.split('\n').map(maskSecrets).join('\n');
}
