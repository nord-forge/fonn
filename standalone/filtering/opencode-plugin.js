// Fonn output filter for OpenCode (plugin API of v1.19.5). Hand-authored; Node builtins only.
// OpenCode loads every export of a plugin file as a plugin, so this file exports one function.
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

// Runs hook.mjs with a PostToolUse payload. Resolves to the filtered text, or undefined to keep the original.
function filtered(spawn, command, args, payload, timeoutMs) {
  return new Promise(done => {
    let settled = false;
    let child;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
    const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } finish(undefined); }, timeoutMs);
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
      const chunks = [];
      let bytes = 0;
      child.on('error', () => finish(undefined));
      child.stdin.on('error', () => finish(undefined));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish(undefined); return; }
        chunks.push(chunk);
      });
      child.on('close', code => {
        if (code !== 0) return finish(undefined);
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(typeof result?.updated_output === 'string' ? result.updated_output : undefined);
        } catch { finish(undefined); }
      });
      child.stdin.end(JSON.stringify(payload));
    } catch { finish(undefined); }
  });
}

/**
 * Environment: FONN_FILTER_HOOK (hook.mjs path; defaults to hook.mjs next to this file),
 * FONN_FILTER_NODE (default "node" from PATH), FONN_FILTER_MODE (filter|observe|off, default filter),
 * FONN_FILTER_LEVEL (strict|standard|similar, default standard) and
 * FONN_FILTER_STATE_DIR (default <project>/.fonn/filtering). The second argument's
 * `spawn` and `timeoutMs` exist for tests only.
 */
export const FonnFilter = async ({ directory } = {}, options = {}) => {
  const env = process.env;
  const project = typeof directory === 'string' && isAbsolute(directory) ? directory : process.cwd();
  const hook = resolve(env.FONN_FILTER_HOOK || join(dirname(fileURLToPath(import.meta.url)), 'hook.mjs'));
  const node = env.FONN_FILTER_NODE || 'node';
  const mode = env.FONN_FILTER_MODE || 'filter';
  const level = env.FONN_FILTER_LEVEL || 'standard';
  const stateDirectory = resolve(project, env.FONN_FILTER_STATE_DIR || '.fonn/filtering');
  const spawn = typeof options?.spawn === 'function' ? options.spawn : nodeSpawn;
  const timeoutMs = Number.isSafeInteger(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_MS;
  const args = [hook, 'hook', '--provider', 'opencode', '--mode', mode, '--level', level, '--state-dir', stateDirectory];
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (input?.tool !== 'bash' || typeof output?.output !== 'string' || mode === 'off') return;
        const payload = {
          hook_event_name: 'PostToolUse', tool_name: 'bash', session_id: input.sessionID,
          tool_use_id: input.callID, tool_input: input.args, tool_response: output.output, cwd: project,
        };
        const text = await filtered(spawn, node, args, payload, timeoutMs);
        if (typeof text === 'string') output.output = text;
      } catch { /* fail open: keep the original output */ }
    },
  };
};
