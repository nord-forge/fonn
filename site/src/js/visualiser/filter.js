// Runs the real compiled filter (copied to /filter at build time) on one
// observation. The archive is kept in memory instead of on disk.
import { createOutputFilter } from '../../filter/index.js';

const FALLBACK_ID = '3f6c1d2e-8a4b-4c1d-9e2f-5a6b7c8d9e0f';

export async function runFilter({ mode, level, command, stdout }) {
  let archived;

  const filter = createOutputFilter({
    mode,
    level,
    store: {
      async save() {
        archived = { id: globalThis.crypto?.randomUUID?.() ?? FALLBACK_ID, text: stdout };
        return { id: archived.id };
      },
    },
    recoveryHint: (id) => `Recover the original tool response with: fonn native-output <launch-id> ${id}`,
  });

  const { response, decision } = await filter.apply({
    toolName: 'Bash',
    toolInput: { command },
    response: { stdout, stderr: '' },
    sessionId: 'visualiser',
    toolUseId: 'visualiser',
  });

  return { delivered: response.stdout, decision, archived };
}
