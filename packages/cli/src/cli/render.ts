import type { RunRecord } from '@nord-forge/fonn-core/contracts';
import { taskResultSchema } from '@nord-forge/fonn-core/schema';

/** Make untrusted model/tool strings inert in terminals, including bidi controls. */
export function terminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function validateResult(record: RunRecord): void {
  if (record.result !== undefined && !taskResultSchema.safeParse(record.result).success) {
    throw new Error(`Run ${terminalText(record.taskId)} contains an invalid structured result.`);
  }
}

function bounded(value: string, limit = 800): string {
  const safe = terminalText(value);
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

export function renderRun(record: RunRecord): string {
  validateResult(record);
  const lines = [
    `${terminalText(record.taskId)} — ${record.status.toUpperCase()}`,
    `Profile: ${record.profile.name} (${record.profile.model}, ${record.profile.effort})`,
    `Estimated API cost: $${record.usage.estimatedCostUsd.toFixed(4)} / $${record.budgetUsd.toFixed(2)} stop budget (may overshoot)`,
  ];
  if (record.error) lines.push(`Error: ${terminalText(record.error)}`);
  if (record.result) {
    const result = record.result;
    lines.push('', terminalText(result.summary));
    if (result.changes.length) lines.push('', 'Changes:', ...result.changes.map(change => `- ${terminalText(change)}`));
    lines.push('', 'Checks:', ...(result.checks.length ? result.checks.map(check =>
      `- [${check.status.toUpperCase()}] ${terminalText(check.name)}: ${terminalText(check.details)}`) : ['- None reported.']));
    if (result.unresolved.length) lines.push('', 'Unresolved:', ...result.unresolved.map(item => `- ${terminalText(item)}`));
    for (const handoff of result.handoffs.slice(0, 4)) {
      lines.push('', `Handoff (${handoff.agent}): ${bounded(handoff.task, 300)}`);
      lines.push(...handoff.findings.slice(0, 6).map(item => `- ${bounded(item)}`));
      lines.push(...handoff.evidence.slice(0, 6).map(item =>
        `  ${bounded(item.path, 200)}${item.line ? `:${item.line}` : ''}: ${bounded(item.note)}`));
      lines.push(...handoff.unresolved.slice(0, 4).map(item => `- Unresolved: ${bounded(item)}`));
      if (handoff.findings.length > 6 || handoff.evidence.length > 6 || handoff.unresolved.length > 4) {
        lines.push('  Further handoff details are available with show --json.');
      }
    }
    if (result.handoffs.length > 4) lines.push('Further handoffs are available with show --json.');
  } else lines.push('', 'No structured task result was saved.');
  const original = record.filters.reduce((sum, item) => sum + item.originalCharacters, 0);
  const delivered = record.filters.reduce((sum, item) => sum + item.deliveredCharacters, 0);
  const filtered = record.filters.filter(item => item.status === 'filtered').length;
  const observed = record.filters.filter(item => item.status === 'observed').length;
  lines.push('', `Filtering (${record.filterMode}${record.filterLevel ? `, ${record.filterLevel}` : ''}): ${filtered} reduced, ${observed} observed; ${original} → ${delivered} characters.`);
  return lines.join('\n');
}

export function runExitCode(record: RunRecord): number {
  return record.status === 'succeeded' && !record.result?.checks.some(check => check.status === 'failed') ? 0 : 1;
}
