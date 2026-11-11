// The OpenCode plugin that `fonn hooks install` writes to the global plugin
// folder. It follows standalone/filtering/opencode-plugin.js, but runs
// `fonn hook --agent opencode` instead of the downloaded hook.mjs.

export const OPENCODE_PLUGIN_MARKER = '// Fonn hook for OpenCode: runs fonn hook --agent opencode on bash output.';

export function opencodePlugin(argv: readonly string[]): string {
  return `${OPENCODE_PLUGIN_MARKER}
// Written by fonn hooks install. fonn hooks uninstall removes this file.
// Node builtins only. On any error, or after 5 seconds, the output stays as it was.
// OpenCode loads every export of a plugin file as a plugin, so this file exports one function.
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const COMMAND = ${JSON.stringify(argv)};
const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

function filtered(payload) {
  return new Promise(done => {
    let settled = false;
    let child;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
    const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } finish(undefined); }, TIMEOUT_MS);
    try {
      child = spawn(COMMAND[0], COMMAND.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
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

export const FonnHook = async ({ directory } = {}) => {
  const project = typeof directory === 'string' && isAbsolute(directory) ? directory : process.cwd();
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (input?.tool !== 'bash' || typeof output?.output !== 'string') return;
        const text = await filtered({
          hook_event_name: 'PostToolUse', tool_name: 'bash', session_id: input.sessionID,
          tool_use_id: input.callID, tool_input: input.args, tool_response: output.output, cwd: project,
        });
        if (typeof text === 'string') output.output = text;
      } catch { /* fail open: keep the original output */ }
    },
  };
};
`;
}

/** The command a Fonn plugin file runs, or undefined when it cannot be read. */
export function opencodePluginCommand(text: string): string[] | undefined {
  const match = /^const COMMAND = (\[.*\]);$/m.exec(text);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined;
  } catch { return undefined; }
}
