import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactInput, ArtifactSlice, ArtifactStore } from '../contracts.js';

const MAX_LIMIT = 20_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One instance belongs to one task. No retention or automatic deletion policy is applied. */
export function createArtifactStore(root: string): ArtifactStore {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new Error('Invalid artifact directory');
  const directory = resolve(root);
  let initialized: Promise<{ canonical: string; dev: number; ino: number }> | undefined;

  async function initialize() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Invalid artifact directory');
    const canonical = await realpath(directory);
    await chmod(canonical, 0o700);
    return { canonical, dev: entry.dev, ino: entry.ino };
  }

  async function checkedDirectory() {
    initialized ??= initialize();
    const expected = await initialized;
    const current = await lstat(directory);
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino || await realpath(directory) !== expected.canonical) {
      throw new Error('Artifact directory changed');
    }
    return expected.canonical;
  }

  return {
    async save(input: ArtifactInput) {
      // Store precisely the original response, never the command or other observation metadata.
      const serialized = JSON.stringify(input.response, null, 2);
      if (typeof serialized !== 'string') throw new Error('Response is not JSON serializable');
      const location = await checkedDirectory();
      const id = randomUUID();
      const temporary = join(location, `.${id}.${randomUUID()}.tmp`);
      const target = join(location, `${id}.json`);
      let pending = true;
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await file.writeFile(serialized, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await checkedDirectory();
        await rename(temporary, target);
        pending = false;
        await checkedDirectory();
        return { id, createdAt: new Date().toISOString(), characters: serialized.length };
      } finally {
        if (pending) await unlink(temporary).catch(() => undefined);
      }
    },
    async read(id, options = {}): Promise<ArtifactSlice> {
      if (!ID_PATTERN.test(id)) throw new Error('Invalid artifact id');
      const offset = options.offset ?? 0;
      const limit = options.limit ?? MAX_LIMIT;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error('Invalid artifact read bounds');
      }
      const location = await checkedDirectory();
      const file = await open(join(location, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      let serialized: string;
      try {
        const entry = await file.stat();
        if (!entry.isFile() || entry.nlink !== 1) throw new Error('Invalid artifact file');
        serialized = await file.readFile('utf8');
      } finally {
        await file.close();
      }
      await checkedDirectory();
      if (offset > serialized.length) throw new Error('Artifact offset exceeds length');
      const text = serialized.slice(offset, offset + limit);
      const end = offset + text.length;
      return { id, text, offset, nextOffset: end < serialized.length ? end : null, totalCharacters: serialized.length };
    },
  };
}
