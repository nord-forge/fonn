import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ArtifactStore } from '../contracts.js';

/** Resume exposes only explicitly validated ancestors, never a global artifact search. */
export function createTaskRecoveryStore(current: ArtifactStore, ancestors: readonly ArtifactStore[]): ArtifactStore {
  return {
    save: (input) => current.save(input),
    async read(id, options) {
      for (const store of [current, ...ancestors]) {
        try { return await store.read(id, options); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      throw new Error('Artifact does not belong to this task or its validated session ancestors');
    },
  };
}

export const recoveryInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(20_000).default(20_000),
}).strict();

/** The capability is a task-scoped store, never a caller-supplied filesystem path. */
export function createRecoveryReader(store: ArtifactStore) {
  return async (input: unknown) => {
    const { id, offset, limit } = recoveryInputSchema.parse(input);
    const slice = await store.read(id, { offset, limit });
    if (slice.id !== id || slice.offset !== offset || slice.text.length > limit || !Number.isInteger(slice.totalCharacters) || slice.totalCharacters < 0) throw new Error('Invalid artifact slice');
    return slice;
  };
}

export function createRecoveryServer(store: ArtifactStore) {
  const read = createRecoveryReader(store);
  return createSdkMcpServer({ name: 'fonn', version: '1.0.0', tools: [
    tool('read_output', 'Read an original tool observation saved by this task. Only artifact IDs issued for this task are accepted. Reads are bounded to 20000 characters; use nextOffset to continue.', recoveryInputSchema.shape,
      async (input) => {
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(await read(input)) }] }; }
        catch { return { isError: true, content: [{ type: 'text' as const, text: 'Artifact unavailable or invalid bounded artifact request.' }] }; }
      }, { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }),
  ] });
}
