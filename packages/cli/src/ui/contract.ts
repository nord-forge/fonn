// The contract between the fonn ui server (server.ts, api.ts) and the web
// interface (web/). Both sides code against these shapes. Reads are GET.
// Changes use POST, PUT or DELETE and go through the same validated, locked
// stores as the CLI; see "Changes" below.
//
// Security model (implemented in server.ts):
// - Listens on 127.0.0.1 only, on a random free port unless --port is given.
// - A random 32-byte token is created per start. The printed URL is
//   http://127.0.0.1:<port>/?token=<token>. Visiting it sets an HttpOnly,
//   SameSite=Strict session cookie and redirects to / without the token.
// - Every request needs the cookie (or an `Authorization: Bearer <token>`
//   header, used by tests). Missing or wrong: 401 with no body details.
// - The Host header must be 127.0.0.1:<port> or localhost:<port>, which
//   blocks DNS rebinding. Requests carrying an Origin header must use that
//   same origin. Anything else: 403.
// - Responses send Content-Security-Policy "default-src 'self';
//   frame-ancestors 'none'", X-Frame-Options DENY, X-Content-Type-Options
//   nosniff, Referrer-Policy no-referrer and Cache-Control no-store. No CORS
//   headers are ever sent. Without a session, pages get a short "session
//   ended" HTML page and API calls get a 401 JSON error.
// - Never send credentials, environment variables or API keys. Archived
//   originals are only sent as bounded slices (at most 20,000 characters).
//
// Changes (POST, PUT, DELETE on /api/...):
// - Require the session, an Origin header equal to the server's origin,
//   `Content-Type: application/json` (bodies are JSON, at most 64 KB) and the
//   header `X-Fonn-Request: 1`. Missing any of these: 403. Together with the
//   SameSite=Strict cookie this blocks cross-site requests.
// - Validation errors return 400 with a message that is safe to show.
// - GET and HEAD stay as before; other methods on non-API paths get 405.
//
// All endpoints return JSON. Errors use ApiError with a matching status.

export type Provider = 'claude' | 'codex';
export type FilterMode = 'filter' | 'observe' | 'off';
export type FilterLevel = 'strict' | 'standard' | 'similar';
export type Subagents = 'auto' | 'off';
export type SettingSource = 'flag' | 'local' | 'shared' | 'global' | 'default';

export interface ApiError {
  error: string;
}

/** A user filter rule: for commands starting with `command`, remove lines containing any `remove` text. */
export interface FilterRule {
  /** 1 to 60 characters, unique within one file. */
  name: string;
  /** 1 to 200 characters, one line. Matches the command itself or the command followed by a space. */
  command: string;
  /** 1 to 20 texts of 3 to 200 characters each. Lines mentioning errors, failures or warnings are never removed. */
  remove: string[];
}

export interface ResolvedRule extends FilterRule {
  source: 'global' | 'shared' | 'local';
}

/** GET /api/overview */
export interface Overview {
  version: string;
  node: string;
  platform: string;
  configDirectory: string;
  stateDirectory: string;
  counts: { profiles: number; projects: number; launches: number; runs: number };
}

export interface ProfileSummary {
  name: string;
  provider: Provider;
  model: string;
  effort: string;
  /** Codex only: 'ollama', 'lmstudio' or 'provider:<name>'; null means the agent's own service. */
  source: string | null;
  builtIn: boolean;
  isDefault: boolean;
}

/** GET /api/profiles */
export interface ProfilesResponse {
  defaultProfile: string;
  profiles: ProfileSummary[];
}

export interface ResolvedValue<T> {
  value: T;
  source: SettingSource;
}

export interface EffectiveSettings {
  profile: ResolvedValue<string>;
  filterLevel: ResolvedValue<FilterLevel>;
  filterMode: ResolvedValue<FilterMode>;
  subagents: ResolvedValue<Subagents>;
  /** Global, shared and personal rules together; a more specific rule with the same name replaces the broader one. */
  rules: ResolvedRule[];
  /** Project rules that are not applied because the user has not approved them. */
  unapprovedRules: ResolvedRule[];
}

/**
 * Project files can be written by anyone who can commit to the repository, so
 * their rules only apply once the user approves them. Approval is stored
 * against a fingerprint of the rules; changed rules need approving again.
 */
export interface RulesApproval {
  /** Null when the project has no rules. */
  fingerprint: string | null;
  approved: boolean;
}

/** GET /api/settings/global: only the values that are actually saved. */
export interface GlobalSettingsResponse {
  file: string;
  settings: { profile: string; filterLevel?: FilterLevel; filterMode?: FilterMode; subagents?: Subagents; rules?: FilterRule[] };
  /** The text Fonn adds at session start when subagents is auto. */
  delegationGuidance: string;
}

export interface FilterTotals {
  decisions: number;
  filtered: number;
  observed: number;
  unchanged: number;
  originalCharacters: number;
  deliveredCharacters: number;
  removedLines: number;
}

export interface ProjectSummary {
  /** Absolute project root. */
  root: string;
  /** Last path segment, for display. */
  name: string;
  launches: number;
  runs: number;
  lastUsed: string | null;
  hasSharedSettings: boolean;
  hasLocalSettings: boolean;
}

/** GET /api/projects: every project seen in launch or run records. */
export interface ProjectsResponse {
  projects: ProjectSummary[];
}

export interface SettingsFileInfo {
  path: string;
  exists: boolean;
  /** A hash of the file's contents, 'missing' or 'unreadable'. Saves send it back. */
  version: string;
  settings: Partial<Record<'profile' | 'filterLevel' | 'filterMode' | 'subagents', string>> & { rules?: FilterRule[] };
  /** Set when the file exists but is invalid; the message is safe to show. */
  error?: string;
}

export interface InstructionFile {
  /** One of the allow-listed names below, relative to the project root. */
  name: 'CLAUDE.md' | 'AGENTS.md' | '.claude/CLAUDE.md' | 'CLAUDE.local.md';
  exists: boolean;
  bytes: number;
}

/**
 * GET /api/project?root=<absolute path>
 * The root may be a project from the records, or any folder that is a Git
 * repository root or already has a Fonn settings file. Anything else: 404.
 * The same rule applies to every endpoint that takes a `root`.
 */
export interface ProjectDetail {
  root: string;
  name: string;
  shared: SettingsFileInfo;
  local: SettingsFileInfo;
  /** Null when a settings file is invalid, so effective values cannot be known. */
  effective: EffectiveSettings | null;
  /** Null when a settings file is invalid. */
  rulesApproval: RulesApproval | null;
  instructions: InstructionFile[];
  totals: FilterTotals;
}

/** GET /api/project/instructions?root=<path>&name=<InstructionFile name>, at most 200 KB. */
export interface InstructionContent {
  name: InstructionFile['name'];
  text: string;
  truncated: boolean;
}

export interface LaunchSummary {
  launchId: string;
  provider: Provider;
  profile: string;
  model: string | null;
  cwd: string;
  projectRoot: string;
  createdAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  filterMode: FilterMode;
  filterLevel: FilterLevel;
  subagents: Subagents;
  totals: FilterTotals;
}

/** GET /api/launches?root=<optional project root>, newest first, at most 200. */
export interface LaunchesResponse {
  launches: LaunchSummary[];
}

export interface DecisionSummary {
  status: 'filtered' | 'observed' | 'unchanged';
  reason: string;
  adapter: string | null;
  artifactId: string | null;
  originalCharacters: number;
  deliveredCharacters: number;
  removedLines: number;
}

/** GET /api/launches/<launchId> */
export interface LaunchDetail {
  launch: LaunchSummary;
  decisions: DecisionSummary[];
}

/** GET /api/launches/<launchId>/artifacts/<artifactId>?offset=<n>&limit=<n> */
export interface ArtifactSliceResponse {
  launchId: string;
  artifactId: string;
  offset: number;
  text: string;
  nextOffset: number | null;
  totalCharacters: number;
}

export interface RunSummary {
  taskId: string;
  status: string;
  profile: string;
  cwd: string;
  projectRoot: string;
  startedAt: string;
  finishedAt: string;
  filterMode: FilterMode;
  filterLevel: FilterLevel | null;
  estimatedCostUsd: number;
  totals: FilterTotals;
}

/** GET /api/runs?root=<optional project root>, newest first, at most 200. */
export interface RunsResponse {
  runs: RunSummary[];
}

/** Paths the web interface may route to (client-side, hash based). */
export type UiRoute =
  | '#/global'
  | '#/global/profiles'
  | '#/global/activity'
  | '#/global/rules'
  | `#/test${string}`
  | `#/project/${string}`
  | `#/launch/${string}`;


// ---------------------------------------------------------------------------
// Changes. Each returns the updated resource so the interface can re-render.

/** PUT /api/settings/global, body: GlobalSettingChange. Null removes the saved value (profile resets to opus-medium). Returns GlobalSettingsResponse. */
export interface GlobalSettingChange {
  key: 'profile' | 'filterLevel' | 'filterMode' | 'subagents';
  value: string | null;
}

/** PUT /api/settings/global/rules, body: RulesChange. Returns GlobalSettingsResponse. */
export interface RulesChange {
  rules: FilterRule[];
}

/**
 * PUT /api/project/settings, body: ProjectSettingsChange. Replaces one file's
 * contents; an empty object removes the file. Returns ProjectDetail.
 * Writing the personal file warns (`warning`) when .fonn/ is not ignored by Git.
 */
export interface ProjectSettingsChange {
  root: string;
  scope: 'shared' | 'local';
  /** SettingsFileInfo.version from when the page loaded. A file that changed since: 409. */
  version: string;
  settings: { profile?: string; filterLevel?: FilterLevel; filterMode?: FilterMode; subagents?: Subagents; rules?: FilterRule[] };
}
/**
 * PUT /api/project/rules-approval, body: RulesApprovalChange. A fingerprint
 * approves the project's current rules and must equal rulesApproval.fingerprint
 * (409 when the rules changed meanwhile). Null withdraws approval. Returns ProjectDetail.
 * Saving project settings in the UI keeps rules approved only when they already were, or there were none.
 */
export interface RulesApprovalChange {
  root: string;
  fingerprint: string | null;
}

export interface ProjectDetailWithWarning extends ProjectDetail {
  warning?: string;
}

/** POST /api/profiles, body: ProfileCreate. Returns ProfilesResponse. */
export interface ProfileCreate {
  /** Lowercase letters, digits and hyphens, at most 48 characters. */
  name: string;
  provider: Provider;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Codex only. With a source, the model is any name that source uses. */
  source?: string;
}

/** PUT /api/profiles/<name>, body: ProfileEdit (at least one field). Built-in profiles cannot be edited: 400. Returns ProfilesResponse. */
export interface ProfileEdit {
  provider?: Provider;
  model?: string;
  effort?: ProfileCreate['effort'];
  /** null goes back to the agent's own service. */
  source?: string | null;
}
// DELETE /api/profiles/<name>: built-ins and the current default cannot be deleted (400). Returns ProfilesResponse.

/**
 * POST /api/filter/test, body: FilterTest. Runs the real filter in memory and
 * stores nothing. With `root`, that project's effective settings and rules
 * apply; without it, the global ones. `mode`, `level` and `rules` override
 * them, so the interface can try a rule before saving it.
 */
export interface FilterTest {
  command: string;
  /** At most 200,000 characters. This endpoint accepts bodies up to 512 KB; all other changes 64 KB. */
  stdout: string;
  root?: string;
  mode?: FilterMode;
  level?: FilterLevel;
  rules?: FilterRule[];
}
export interface FilterTestResult {
  mode: FilterMode;
  level: FilterLevel;
  rules: FilterRule[];
  decision: DecisionSummary;
  /** Exactly what the model would receive, including the recovery footer. Nothing is archived, so the footer's ID is a placeholder and decision.artifactId is null. */
  delivered: string;
}

/**
 * DELETE /api/launches/<launchId>: removes that launch's records and archived
 * originals. Returns { deleted: launchId }. A launch without a recorded finish
 * may still be running: that returns 409 unless `?confirm=running` is added.
 */
export interface LaunchDeleted {
  deleted: string;
}
