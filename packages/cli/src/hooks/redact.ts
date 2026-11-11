// Hides likely secrets in a config file before it is shown. A plan keeps the
// real contents for writing and fingerprints; only the display is redacted.
import type { HookAgent } from './contract.js';

const WORDS = 'key|token|secret|password|passwd|credential|auth|cookie|session';
const SENSITIVE = new RegExp(WORDS, 'i');
const HIDDEN = '[hidden]';
const VALUE = String.raw`("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'#;&|,)]+)`;

function quoted(value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return `${quote}${HIDDEN}${quote}`;
}

// Well-known token shapes, hidden wherever they appear.
const TOKEN_SHAPES = /\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{10,})/g;
// user:password@ in a URL.
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"']*:)([^\s/@"']+)(@)/gi;
// Headers such as `Authorization: Bearer abc` or `X-Api-Key: abc`, keeping the scheme.
const HEADER = new RegExp(String.raw`(\b[\w-]*(?:${WORDS})[\w-]*\s*:\s*)((?:bearer|basic|token|digest)\s+)?([^\s"'\\,;]+)`, 'gi');
// Every `NAME=value`, `export NAME=value` or `name = "value"` with a sensitive name, anywhere on a line.
const ASSIGNMENT = new RegExp(String.raw`(^|[\s;&|("'\`])([A-Za-z_][\w.-]*)(\s*=\s*)${VALUE}`, 'g');
// Flags such as `--token abc`, `--api-key=abc` or `-p abc` after a sensitive name.
const FLAG = new RegExp(String.raw`(--[\w-]+)(\s+|=)${VALUE}`, 'g');

/** Masks every likely secret in one piece of text. */
export function maskSecrets(text: string): string {
  return text
    .replace(TOKEN_SHAPES, HIDDEN)
    .replace(URL_PASSWORD, `$1${HIDDEN}$3`)
    .replace(HEADER, (match, name: string, scheme: string | undefined, value: string) => value === HIDDEN ? match : `${name}${scheme ?? ''}${HIDDEN}`)
    .replace(ASSIGNMENT, (match, lead: string, name: string, equals: string, value: string) => SENSITIVE.test(name) ? `${lead}${name}${equals}${quoted(value)}` : match)
    .replace(FLAG, (match, flag: string, gap: string, value: string) => SENSITIVE.test(flag) ? `${flag}${gap}${quoted(value)}` : match);
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
    else if (SENSITIVE.test(key) && (typeof item === 'string' || typeof item === 'number' || Array.isArray(item))) result[key] = hideValue(item);
    else result[key] = redactJson(item);
  }
  return result;
}

/**
 * The text to show for a config. JSON configs (Claude, Codex) hide string
 * values under sensitive keys, every value inside an `env` object, and
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
