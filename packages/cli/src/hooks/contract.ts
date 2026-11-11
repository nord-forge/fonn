// Contract for Fonn's global hooks: the main way to use the filter. A user
// installs Fonn once, runs `fonn hooks install`, and keeps using `claude`,
// `codex`, Crush, OpenCode or a GUI on top of them. Every session then gets
// Fonn's filter with the user's global and project settings and approved rules.
//
// Owners: packages/cli/src/hooks/** implements this module and the CLI
// commands. packages/cli/src/ui/** (server, api, web) shows and manages it.
// Both code against these shapes only.
//
// Rules that hold everywhere:
// - Installing merges one Fonn entry into the agent's user-level config. It
//   never replaces the file, never removes or reorders other entries, never
//   touches project or managed policy files, and keeps a backup next to the
//   file the first time. Uninstall removes exactly the entries Fonn added
//   (recognised by the `fonn hook --agent` command) and nothing else.
// - Every write is shown first as a plan (before and after). The CLI asks
//   for confirmation unless --yes is given; the UI shows the plan and needs
//   an explicit click.
// - Codex keeps its own hook trust: after install the user still reviews and
//   trusts the hook in Codex's /hooks. Fonn never writes a trust decision.
// - The hook fails open: on any error, timeout or unknown input it leaves the
//   output unchanged and exits 0, so a broken Fonn never breaks an agent.
// - A session started by `fonn claude` or `fonn codex` already has Fonn's own
//   launch hook; the global hook sees FONN_* launch variables and does nothing.
// - Settings come from the session's working folder: project settings, the
//   global settings, and project rules only when approved (see settings.ts).

export type HookAgent = 'claude' | 'codex' | 'crush' | 'opencode';

export const HOOK_AGENTS: readonly HookAgent[] = Object.freeze(['claude', 'codex', 'crush', 'opencode']);

export const HOOK_AGENT_LABELS: Readonly<Record<HookAgent, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  crush: 'Crush',
  opencode: 'OpenCode',
});

export interface HookStatus {
  agent: HookAgent;
  label: string;
  /** The user-level file Fonn writes: for example ~/.claude/settings.json. */
  configPath: string;
  /** The agent looks installed: its command is on PATH or its config folder exists. */
  detected: boolean;
  /** A Fonn entry is present in the config. */
  installed: boolean;
  /** The entry points at this Fonn installation. False after moving or reinstalling Fonn: install again to update it. */
  current: boolean;
  /** One short sentence for the user, for example about Codex hook trust. */
  note?: string;
  /** Set when the config cannot be read or parsed; safe to show. Install is refused until it is fixed. */
  error?: string;
}

export interface HookPlan {
  agent: HookAgent;
  action: 'install' | 'uninstall';
  configPath: string;
  /** False when nothing would change, for example installing when already current. */
  changes: boolean;
  /** Current file content, or null when the file does not exist yet. */
  before: string | null;
  /** Content after the change, or null when the file would be removed (never for user config files). */
  after: string | null;
  /** Plain sentences describing the change, shown above the diff. */
  summary: string[];
  /** Extra files Fonn writes or removes, for example OpenCode's plugin and filter files. */
  files: Array<{ path: string; action: 'write' | 'remove' }>;
}

export interface HookOptions {
  /** Defaults to the user's home directory; tests pass a temporary one. */
  home?: string;
  /** Defaults to Fonn's config directory. */
  configDirectory?: string;
  /** Defaults to Fonn's state directory. Hook sessions are recorded under <state>/native/. */
  stateDirectory?: string;
  /** The command the agent runs. Defaults to this Fonn installation: process.execPath plus the built main.js. */
  command?: string[];
  /** For detection. Defaults to checking PATH. */
  which?: (name: string) => Promise<boolean>;
}

/**
 * The module packages/cli/src/hooks/index.ts exports:
 *
 *   hookStatus(options?): Promise<HookStatus[]>
 *   planHook(agent, action, options?): Promise<HookPlan>
 *   applyHookPlan(plan, options?): Promise<HookStatus>
 *     Re-reads the file and refuses (throws HookConflictError) if it changed
 *     since the plan was made, so a plan shown to the user is exactly what
 *     gets written.
 *   runHook(agent, input: string, options?): Promise<string>
 *     The hook itself: reads the agent's JSON event, filters a shell command's
 *     output, records the decision, and returns the agent's JSON reply ('' or
 *     '{}' when unchanged). Never throws.
 *
 * CLI:
 *   fonn hooks [status] [--json]
 *   fonn hooks install [--agent <agent>]... [--yes]   (no --agent: every detected agent)
 *   fonn hooks uninstall [--agent <agent>]... [--yes]
 *   fonn hook --agent <agent>                          (run by the agent; reads stdin)
 *
 * Hook sessions are stored like native launches, in <state>/native/<id>/,
 * with launch.json carrying origin 'hook', the agent as provider and no
 * profile. <id> is a UUID derived from the agent and its session id, so one
 * agent session is one record. Activity, original output and deleting records
 * in fonn ui then work for them unchanged, and the recovery footer points at
 * `fonn native-output <id> <artifact-id>`.
 */
export interface HookSessionRecord {
  origin: 'hook';
  provider: HookAgent;
  /** The agent's own session id. */
  agentSessionId: string;
}

// UI endpoints (implemented in packages/cli/src/ui/):
//   GET  /api/hooks                          -> HookStatus[]
//   GET  /api/hooks/<agent>/plan?action=install|uninstall -> HookPlan
//   POST /api/hooks/<agent>/apply  body { action, before } -> HookStatus
//        `before` is the plan's before text; a mismatch returns 409 so the
//        user sees the current file before anything is written.
