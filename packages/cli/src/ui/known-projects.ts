// Projects you saved settings or rules for in fonn ui. Fonn otherwise only
// learns about a project from its session records, so a project you set up
// before any agent worked in it would vanish from the list. The list lives in
// Fonn's own config folder and holds folder paths only. Forgetting a project
// removes it from this list and changes nothing in the project.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const KNOWN_PROJECTS_FILE = 'projects.json';
const MAX_PROJECTS = 200;
const MAX_BYTES = 64 * 1024;

const knownProjectsSchema = z.object({
  format: z.literal(1),
  projects: z.array(z.object({ root: z.string().min(1).max(4096), savedAt: z.string().max(64) }).strict()).max(MAX_PROJECTS),
}).strict();

export interface KnownProject { root: string; savedAt: string }

const fileIn = (configDirectory: string) => path.join(configDirectory, KNOWN_PROJECTS_FILE);

/** The remembered projects. A missing, unreadable or invalid file counts as an empty list. */
export async function readKnownProjects(configDirectory: string): Promise<KnownProject[]> {
  let handle;
  try {
    handle = await open(fileIn(configDirectory), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return [];
    const parsed = knownProjectsSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
    return parsed.success ? parsed.data.projects.filter((project) => path.isAbsolute(project.root)) : [];
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}

/** Writes the whole list in one step, as a private file. Refuses to write through a symlink. */
async function writeKnownProjects(configDirectory: string, projects: KnownProject[]): Promise<void> {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const file = fileIn(configDirectory);
  const existing = await lstat(file).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`${KNOWN_PROJECTS_FILE} must be a regular file.`);
  const temporary = path.join(configDirectory, `.${KNOWN_PROJECTS_FILE}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ format: 1, projects }, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Adds a project, or moves it to the front. The oldest drop off past 200. */
export async function rememberProject(configDirectory: string, root: string, now = new Date()): Promise<void> {
  const projects = (await readKnownProjects(configDirectory)).filter((project) => project.root !== root);
  await writeKnownProjects(configDirectory, [{ root, savedAt: now.toISOString() }, ...projects].slice(0, MAX_PROJECTS));
}

/** Removes a project from the list. True when it was there. */
export async function forgetProject(configDirectory: string, root: string): Promise<boolean> {
  const projects = await readKnownProjects(configDirectory);
  const remaining = projects.filter((project) => project.root !== root);
  if (remaining.length === projects.length) return false;
  await writeKnownProjects(configDirectory, remaining);
  return true;
}
