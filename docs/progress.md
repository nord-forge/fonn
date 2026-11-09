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
