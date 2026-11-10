// Browser stand-in for packages/core/src/filtering/artifact-store.ts, which
// writes to disk. The visualiser keeps archived originals in memory instead.
export function createArtifactStore() {
  throw new Error('The docs site has no file-backed artifact store.');
}
