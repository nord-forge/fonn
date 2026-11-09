# Verification record

The core, CLI and native Claude launcher were verified before the distribution migration with 60 offline tests and an independent review. The native launcher also passed a local Claude help/settings check and a terminal interrupt check.

The monorepo separates reusable SDK behavior in `packages/core`, terminal interaction in `packages/cli`, CLI distribution in `packaging/homebrew`, and the future GUI placeholder in `apps/desktop`. Four packaging tests cover archive contents/checksums, cask metadata, installation boundaries and launcher behavior. Normal checks make no paid model calls.

Live SDK authentication, model availability and actual billing remain unverified. Real-world token savings have not been measured. SDK budget figures are estimated stop thresholds, not guaranteed hard caps. See [billing](billing.md) and [distribution](distribution.md) for supported paths and release prerequisites.

## Fonn distribution verification

| Task | State | Owner / model | Evidence |
| --- | --- | --- | --- |
| Monorepo and Fonn naming | DONE | Coordinator | Core/CLI workspaces, lockfile, single `fonn` binary, native default route; build and typecheck passed. |
| CLI cask preparation | DONE | Packaging builder / gpt-6.1-sol high | Four focused packaging tests passed alongside 60 existing offline tests. |
| Independent distribution review | DONE | Reviewer / gpt-6.1-sol high | Payload path confinement and clean build outputs fixed; isolated reproduction confirms symlinked workspace parent is rejected before cleanup. |
| Public documentation | DONE | Documentation builder / gpt-6.1-sol high | Manual release commands, dependency notices and MCP visibility/context distinction documented. |
| Extracted installation smoke | DONE | Coordinator | Exact archive checksum verified; runtime dependencies installed without lifecycle scripts; CLI help/version/profiles and SDK import passed; real Claude help accepted collapsed per-launch settings; uninstall preserved launch state. No model calls. |

The cask is checked in with the prepared archive's actual SHA-256. Archive and checksum are local ignored release artifacts. A GitHub release and version tag remain unpublished; Homebrew installation from the public release URL requires that later publication. The extracted-install smoke used the installed Node/npm runtime rather than installing Homebrew Node globally. Ruby syntax validation passed; a full Homebrew installation has not been performed.

## Custom profiles

| Task | State | Owner / model | Evidence |
| --- | --- | --- | --- |
| Local registry and atomic storage | DONE | Builder / gpt-6.1-sol high | Three focused registry tests passed; validation, immutable built-ins, defaults, corrupt files, symlinks and mutation locking covered. |
| CLI profile management | DONE | Builder / gpt-6.1-sol high | Create/edit/show/delete/default commands and help; one new CLI test plus existing routing checks passed. |
| SDK/native integration | DONE | Coordinator | Saved SDK snapshots survive profile edits/deletion and invalid current configuration; native launches use configured custom defaults. |
| Independent profile review | DONE | Reviewer / gpt-6.1-sol high | No concrete findings in registry writes, SDK resume, native metadata compatibility, permissions or exports. |

`npm run check` passed: build, typecheck, and 68 offline tests (four new test cases). No paid model calls were made. Model IDs and effort values are validated syntactically, not verified against a live account. Codex support is a separate next change; these profile commands currently target Claude.

## Native Codex and direct script access

| Task | State | Owner / model | Evidence |
| --- | --- | --- | --- |
| Provider-aware profiles | DONE | Builder / gpt-6.1-sol high | Existing registry cases cover provider validation, default selection and legacy configuration compatibility. |
| Native Codex launcher and adapter | DONE | Builder / gpt-6.1-sol high | Three new focused mocked cases cover auth/env inheritance, stable hooks, argument boundaries, output modes and exact recovery. |
| Provider CLI routing | DONE | Builder / gpt-6.1-sol high | Existing CLI cases cover explicit/implicit provider selection, Codex hook dispatch and Claude SDK rejection of Codex profiles. |
| Independent Codex review | DONE | Reviewer / gpt-6.1-sol high | Namespaced `codex:sol-medium` to preserve previously valid custom names; isolated legacy reproduction passes; no remaining findings. |
| README script links | DONE | Coordinator | Direct and raw links for the CLI, native launchers, output filter and distribution scripts; source quickstart explains module dependencies. |

Build, typecheck and all 71 offline tests passed. The refreshed archive passed an extracted installation check with real Claude/Codex help, custom Codex profile management, compiled hook delivery and exact original recovery, SDK import and uninstall preservation. The smoke used installed Node/npm rather than installing Homebrew Node globally. Ruby cask syntax passed. No paid model calls were made.

Actual Codex hook trust/delivery during model work, model availability for a live account and real-world token savings remain unverified. Unknown response shapes pass through unchanged. Native Codex has no Fonn SDK usage accounting or budget enforcement; programmatic tasks remain Claude SDK only. The cask, archive and checksum are prepared, with no GitHub release or tag published.

## Default coding agent shortcut

`fonn --default claude` and `fonn --default codex` persist the selected agent and exit; `fonn --default` displays it, with optional JSON output. The shortcut updates the existing atomic default-profile setting. Selecting the same provider preserves its custom profile; switching providers chooses its built-in default. Explicit agent commands and profiles remain per-launch overrides.

Build, typecheck and all 71 offline tests passed, extending the existing profile/CLI cases without adding test cases. A compiled CLI smoke confirmed selection, persistence, display and preservation of a matching custom profile in isolated temporary configuration, without launching an agent. The prepared archive and cask checksum were refreshed. No release or tag was published.

## Native resume footer and standalone local filtering

| Task | State | Owner / model | Evidence |
| --- | --- | --- | --- |
| Session state and native replay | DONE | Builder / gpt-6.1-sol high | Two focused cases cover lifecycle IDs, private bounded state, provider binding, exact/picker replay and immutable saved profiles. |
| Native shutdown hints | DONE | Builder / gpt-6.1-sol high | Existing Claude/Codex cases cover lifecycle routes, off mode, informational-call suppression, arguments and exit-code preservation. |
| Local downloadable filters | DONE | Builder / gpt-6.1-sol high | One focused case runs four modules plus license without npm dependencies, including both hook protocols, exact recovery and confinement. |
| CLI/docs integration | DONE | Coordinator | Resume help/routing and README download/setup prompt; compiled CLI replayed printed shutdown commands for both mocked providers with quoted state paths and invalid current profile configuration. |
| Independent review | DONE | Reviewer / gpt-6.1-sol high | Source-symlink code-generation finding fixed and independently reproduced as rejected before output creation; no remaining findings. |

Build, typecheck and all 74 offline tests passed (three new cases), followed by the targeted standalone test after the reviewed generator fix. Generated download modules match the shared core, with CI enforcing committed-file parity. No paid model calls were made; the compiled shutdown smoke used fake provider executables. Actual provider lifecycle hook delivery remains subject to native trust/settings and has not been exercised with a paid session. Native resume uses an explicitly labeled picker when no observed session ID exists, and hard kills cannot print a footer. The standalone download/setup guide requires only Node 22+ and an existing native agent; it does not install Fonn or SDKs.
