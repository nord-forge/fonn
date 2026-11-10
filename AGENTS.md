# Fonn

This is an independent TypeScript CLI and reusable library for native Claude and Codex, with structured tasks through the Claude Agent SDK. Read `README.md` and `packages/core/src/contracts.ts` before changing public behavior.

## Workspace ownership

- `packages/core` (`@nord-forge/fonn-core`) owns contracts, profiles, schemas, filtering, artifact recovery, SDK runtime.
- `packages/cli` (`@nord-forge/fonn-cli`) owns terminal I/O, native Claude and Codex launch services, command dispatch, rendering, and interactive approval/question handling. Import the core package rather than duplicating it.
- `apps/desktop/README.md` reserves the future desktop host. No GUI, `.app`, signing/notarization pipeline, or GUI cask is implemented.
- `packages/cli/dist/cli/main.js` is the canonical built CLI entrypoint. Keep the root `dist/cli/main.js` compatibility shim for local development.
- `fonn` with no arguments or leading launcher options opens the native CLI selected by its profile; `fonn claude` and `fonn codex` explicitly select a provider. Preserve the explicit SDK and administration commands. `--help` and `--version` remain offline.
- `site/` is the Astro Starlight docs site. It is a separate npm project with its own `site/package-lock.json`. Never add it to the root workspaces: the Homebrew runtime runs `npm ci --omit=dev` against the root lockfile on users' machines.
- The root is a private npm-workspace coordinator. Keep workspace, root, and lockfile versions consistent. Shared contracts, package manifests, and the lockfile have one owner during parallel work.

## Verification

Use Node 22 or later; CI uses Node 24. From the root run `npm ci` and `npm run check` (typecheck, mocked tests, build). `npm run release:prepare` creates the CLI release archive and matching cask; `npm run release:check` validates release packaging. Inspect the scripts before assuming which prerequisites they run.

Tests must use fixtures and mocked SDK messages. Normal checks must never make paid model calls. Keep new dependencies minimal and pin exact versions. Regenerate and commit `standalone/filtering` with shared filter changes; downloaded modules must remain Node-builtin-only and match the compiled core. Cover meaningful behavior rather than duplicating implementation assertions. Never use real credentials, personal state, stored prompts, or private source as fixtures or release content.

## Product boundaries

- Preserve the target project's user, project, local, and managed policy settings.
- Use the Claude Code system-prompt preset. Never add permission bypass or silently approve writes and shell commands.
- SDK authentication initially requires an explicitly supplied `ANTHROPIC_API_KEY`. Do not extract subscription OAuth credentials or imply subscription quotas apply to API use. Native launchers inherit their corresponding CLI authentication and policy layers. Never extract either provider’s subscription credentials or bypass Codex hook trust.
- SDK dollar figures and stop budgets are estimates. A request may overshoot a threshold. Never call estimates invoices or guarantee savings.
- A filter rewrites only a new tool observation. It must not rewrite history, source files, user instructions, or reasoning blocks.
- Reduce only recognized output formats, plus the generic collapse of byte-identical adjacent lines. `--filter-level strict` turns the generic collapse off. Similar-line collapsing stays opt-in at `--filter-level similar` and never merges problem lines. Preserve warnings, failures, stderr content (both agents merge it into the command output), and other unknown content. Keep originals recoverable and reads bounded within the current task store and validated same-session/project ancestry.
- Validate structured results and handoffs before rendering. Never present errors as successful checks.
- Never log credentials or store secrets in configuration. Fonn records and raw artifacts are sensitive; retention is manual.
- Preserve resume locking, profile/project invariants, and explicit indeterminate-accounting failures on usage regressions.

## Distribution and collaboration

The public repository and Homebrew tap are the same `nord-forge/fonn` repository. Keep the explicit two-argument tap URL in instructions. The CLI release archive excludes `node_modules`, upstream SDK code/binaries, credentials, and local state; the cask installs locked runtime dependencies on the user's machine with Homebrew Node and no `sudo`. Do not describe Homebrew installation as available until a first release asset and matching cask are published. Read `docs/distribution.md` before changing packaging.

Project code is MIT licensed; upstream SDK code remains under its own terms. Do not relabel dependencies as MIT or imply Anthropic endorsement.

CI and manual preparation workflows may build, test, and upload review artifacts only. They must not publish packages/releases, create tags/remotes, or deploy. Do not commit, push, publish, or deploy unless the user specifically authorizes the relevant action. Check repository policy and automation side effects before any remote mutation.

Keep changes within the assigned scope. Do not revert other contributors' work. Keep `docs/progress.md` as the verification record and preserve its existing evidence.
