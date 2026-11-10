export type FilterMode = 'filter' | 'observe' | 'off';
/**
 * How far filter and observe modes reduce output.
 * strict: format adapters only. standard: adds identical-line collapsing for
 * any command. similar: also collapses lines that differ only in numbers or IDs.
 */
export type FilterLevel = 'strict' | 'standard' | 'similar';
/** See FilterRule in filtering/adapters.ts; repeated here so contracts stay dependency-free. */
export interface FilterRule {
  name: string;
  command: string;
  remove: string[];
}
export type ProfileName = string;
export type ProfileProvider = 'claude' | 'codex';
export type ProfileEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface TaskProfile {
  provider?: ProfileProvider;
  name: ProfileName;
  model: string;
  effort: ProfileEffort;
}

export interface ToolObservation {
  toolName: string;
  toolInput: unknown;
  response: unknown;
  sessionId: string;
  toolUseId: string;
  cwd: string;
}
export interface ArtifactInput {
  toolName: string;
  sessionId: string;
  toolUseId: string;
  response: unknown;
}
export interface ArtifactRecord {
  id: string;
  createdAt: string;
  characters: number;
}
export interface ArtifactSlice {
  id: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
}
export interface ArtifactStore {
  save(input: ArtifactInput): Promise<ArtifactRecord>;
  read(id: string, options?: { offset?: number; limit?: number }): Promise<ArtifactSlice>;
}
export interface FilterDecision {
  mode: FilterMode;
  status: 'filtered' | 'observed' | 'unchanged';
  adapter?: string;
  artifactId?: string;
  originalCharacters: number;
  proposedCharacters: number;
  deliveredCharacters: number;
  removedLines: number;
  reason: string;
}
export interface FilterOutcome {
  response: unknown;
  decision: FilterDecision;
}
export interface OutputFilter {
  apply(observation: ToolObservation): Promise<FilterOutcome>;
}
export interface OutputFilterOptions {
  store: ArtifactStore;
  mode: FilterMode;
  /** Defaults to standard. */
  level?: FilterLevel;
  /** User rules: remove lines containing given text for matching commands. */
  rules?: readonly FilterRule[];
  minimumCharacters?: number;
  minimumSavingsCharacters?: number;
  onDecision?: (decision: FilterDecision) => void;
  recoveryHint?: (artifactId: string) => string;
}

export interface Handoff {
  agent: 'explorer' | 'reviewer';
  task: string;
  findings: string[];
  evidence: Array<{ path: string; line?: number; note: string }>;
  unresolved: string[];
}
export interface TaskResult {
  summary: string;
  changes: string[];
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'not_run'; details: string }>;
  unresolved: string[];
  handoffs: Handoff[];
}
export interface TaskUsage {
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface RunRecord {
  schemaVersion: 1;
  taskId: string;
  sessionId?: string;
  parentTaskId?: string;
  startedAt: string;
  finishedAt: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'budget_exceeded';
  profile: TaskProfile;
  cwd: string;
  budgetUsd: number;
  maxTurns: number;
  filterMode: FilterMode;
  /** Absent on records saved before filter levels existed. */
  filterLevel?: FilterLevel;
  /** User filter rules the task ran with; absent when there were none. */
  filterRules?: FilterRule[];
  result?: TaskResult;
  usage: TaskUsage;
  filters: FilterDecision[];
  error?: string;
}
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
}
export interface UserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}
export interface QuestionRequest {
  questions: UserQuestion[];
}
export interface RunTaskOptions {
  prompt: string;
  cwd: string;
  profile?: ProfileName;
  configDirectory?: string;
  budgetUsd?: number;
  maxTurns?: number;
  filterMode?: FilterMode;
  filterLevel?: FilterLevel;
  filterRules?: FilterRule[];
  stateDirectory?: string;
  resumeTaskId?: string;
  signal?: AbortSignal;
  approveTool?: (request: PermissionRequest) => Promise<boolean>;
  answerQuestions?: (request: QuestionRequest) => Promise<Record<string, string> | undefined>;
  onEvent?: (event: { type: string; message: string }) => void;
}
