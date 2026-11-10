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


## Native automatic delegation and worker filtering

| Task | State | Owner / model | Evidence |
| --- | --- | --- | --- |
| Native orchestration hooks | DONE | Builder / gpt-6.1-sol high | Default auto parent guidance, independent off preference, worker filtering notice and fail-open lifecycle adapters; ten focused native tests passed. |
| CLI, saved preference and docs | DONE | Coordinator | Native-only auto/off flag, provider routing, legacy-off replay, saved preference replay, help and README permission/filtering explanation. |
| Child filtering coverage | DONE | Builder / gpt-6.1-sol high | Existing cases cover synthetic Opus/Sonnet/Haiku and Codex worker Bash events, exact original recovery, mode combinations and parent lifecycle-ID isolation. |
| Independent review | DONE | Reviewer / gpt-6.1-sol high | No concrete findings in permissions/trust, JSON contracts, filtering/recovery, flags, saved/legacy resume or docs. |

Build and typecheck passed; all 74 offline tests passed after updating the existing lifecycle fixture for explicit child-ID isolation. No top-level tests were added. No paid model calls or real worker launches were made. Native delegation and concurrency/read-only preferences are model instructions, not hard enforcement. Filtering uses provider session-wide supported Bash hook paths for every model; unknown/unsupported output passes through. Live provider hook inheritance/delivery and model delegation decisions remain unmeasured. Codex hooks require normal manual review/trust. The launcher does not start headless worker CLIs, change permissions/sandbox policy, or widen tool allowlists after a rejected delegation. Existing SDK bounds are unchanged.


## Fable 5.2 and Mythos 5.2 support

Added `claude:fable-medium` and `claude:mythos-medium` built-ins without changing the default or shadowing existing custom names. The new Fonn short names `fable` and `mythos` normalize to exact 5.2 model IDs before saving/launching/replaying. Native 5.2 launches require Claude Code 2.1.321+ before writing state; other models retain the 2.1.319 baseline. Agent SDK is pinned to 0.3.321, including release validation and notices. Existing filtering, permission checks, native worker hooks, SDK worker models and resume snapshots are preserved.

Build, typecheck and all 74 offline tests passed with no added top-level cases. Existing checks now cover alias persistence/provider rejection, legacy custom names, built-in/native/SDK routing, SDK replay, old native version rejection and filtering/exact recovery for synthetic Fable/Mythos workers. No paid model calls or account-access probes were made. Live entitlement, provider behavior and real token/cost changes remain unverified. Mythos access is controlled by Anthropic; selecting a preset does not grant access or change authentication/billing.


## Documentation site

| Task | State | Owner / model | Evidence |
| --- | --- | --- | --- |
| Static docs page | DONE | Coordinator / claude-opus-5-5 | `site/src/index.html` covers overview, how it works, formats, install routes (source, standalone, Homebrew awaiting first release), everyday use, generated profiles, permissions/billing, FAQ and links. WebGL hero with CSS fallback and a reduced-motion still frame. |
| Interactive visualiser | DONE | Coordinator / claude-opus-5-5 | `site/src/how-it-works.html` runs the compiled core `createOutputFilter` in the browser with a stub artifact store. It shows the stopping check, removed and added lines, observe mode, and bounded recovery slices. |
| Build, preview and Vercel | DONE | Coordinator / claude-opus-5-5 | `npm run docs:build` compiles the core and runs `scripts/docs/build.mjs`. `npm run docs:dev` serves loopback port 4321. Root `vercel.json` uses framework null, `npm ci --ignore-scripts`, `npm run docs:build` and `site/dist`. CI builds the site with no deployment step. |

The build checks all 8 samples against the compiled filter (5 reduced, 3 passed through for unknown format, ambiguous pipeline, ANSI output and short output) and validates every local link, asset and anchor across both pages. No new dependencies or top-level tests were added. `npm run check` passed with all 74 offline tests. `npm run release:prepare` was rerun after the README and manifest changes, and `Casks/fonn.rb` now carries the reproduced archive checksum. `release:check` passed. Browser QA used headless Chrome driven over CDP from a scratch script. It covered 1440x900 and 390x844 in light and dark, with no horizontal page overflow. It also covered tabs and hash selection, the copy button count, every visualiser sample, filter/observe/off, editing the command, and recovery offsets. Clipboard writes and real GPU rendering were not exercised headlessly, since the hero ran on SwiftShader. Sample character counts are illustrative and are not token or cost measurements. No paid model calls were made. The site has not been deployed.


## Generic repeated-line and opt-in similar-line filtering

| Task | State | Owner / model | Evidence |
| --- | --- | --- | --- |
| Core reduction | DONE | Coordinator / claude-opus-5-5 | When no format adapter applies, any command's output collapses runs of 3+ byte-identical non-blank adjacent lines to one copy and an exact count. The opt-in `similarLines` option also collapses runs of 4+ lines equal after masking digits, UUIDs and long hex IDs, keeping the first and last. Problem-keyword lines and wordless lines are never merged by similarity. Both notes count as already filtered. |
| CLI, native, SDK and standalone | DONE | Coordinator / claude-opus-5-5 | `--collapse-similar` for native Claude/Codex launches, `fonn run` and the standalone hook. It is rejected with `--filter off`, saved in launch and run records only when true, and restored by `fonn resume`. |
| Docs and site | DONE | Coordinator / claude-opus-5-5 | Filtering, local filtering, Codex and subagent guides, README, help text and the `AGENTS.md` product boundary. The site has a formats table row, a similar-lines section, two new demo tabs, a visualiser toggle and a repeated-lines sample. The docs build checks all 9 samples with and without the option. |

Build, typecheck and all 75 offline tests passed. One new core case covers identical runs from a pipeline, similar runs with the opt-in, kept error lines and idempotence. Existing CLI and standalone tests gained flag assertions. Three existing pass-through assertions used one repeated line as their "unknown output". They now use varied lines, because identical runs are reduced by design. Release preparation was rerun after the README change and `Casks/fonn.rb` carries the new checksum. Browser QA covered the visualiser toggle and the new docs tabs. No paid model calls were made. Real-world false-positive rates for similar-line masking have not been measured. The option is documented for logs where exact repeated numbers do not matter.


## Filter levels

`--filter-level strict|standard|similar` replaces the unreleased `--collapse-similar` flag. `strict` runs the format adapters only, `standard` (the default) adds identical-line collapsing, and `similar` adds similar-line collapsing. `fonn --default-filter-level [level]` saves or shows the default in `profiles.json`, and `--filter-level` overrides it for one launch or run. Native launch and SDK run records store the level. `fonn resume` and SDK resume restore it, and records saved before levels existed replay as `strict`. SDK resume does not read configuration, so a broken config file still cannot block it. An explicit `--filter-level` with `--filter off` is rejected, and a saved level is ignored when filtering is off. The standalone hook takes `--level` and defaults to `standard`. Docs, help, the site's level table and the visualiser's level switch are updated. The docs build checks all 9 samples at all three levels.

Build, typecheck and all 75 offline tests passed. The existing generic-filtering case now also asserts strict pass-through. The CLI case covers saving, using and overriding a saved level, the off rejection and invalid values. Two exact-options routing assertions gained the resolved `standard` level. Release preparation was rerun and `Casks/fonn.rb` carries the new checksum. Browser QA covered the level switch and mobile widths without horizontal page overflow. No paid model calls were made.


## pytest, Jest and Vitest adapters

Added format adapters for pytest (`pytest`, `py.test`, `python -m pytest`, `.venv/bin/pytest`), Jest (`jest`, `npx jest`) and Vitest (`vitest`, `npx vitest run`). `npm test`, `npm run test`, `pnpm test` and `yarn test` try Jest, then Vitest. Each adapter requires the runner's own summary before removing anything. pytest drops rows made only of dots with a `[ NN%]` counter and `-v` `PASSED` lines. Jest drops `PASS <file>` lines and `✓` lines. Vitest drops `✓` lines. Failure, skip and warning markers, console output and summaries stay. The adapters run at every level, including `strict`. Docs, help and the site formats table list them, and the visualiser gained pytest and Jest samples. The docs build checks 11 samples at all three levels.

Build, typecheck and all 76 offline tests passed. One new core case uses hand-written pytest, Jest and Vitest fixtures. It checks the adapter choice, removed-line counts, kept failure/skip/warning lines across command forms, and no change when the summary is missing. Fixtures are illustrative and not captured from real projects. Real runner output varies by version, reporter and colour settings, and has not been sampled across versions. Release preparation was rerun and `Casks/fonn.rb` carries the new checksum. No paid model calls were made.

Follow-up stream check. A side review warned that Jest writes its report to stderr while Fonn reads only `stdout`. Claude Code's documented Bash output puts the command's stdout and stderr, merged, in `tool_response.stdout`; its `stderr` field holds tool notices. Codex's PostToolUse `tool_response` for shell commands is a plain string of the aggregated output (from its `ExecCommandToolOutput` source). A local probe ran Jest 29.7.0 and Vitest 5.1.0 on a throwaway 41-file project, with no colour codes when piped. Jest wrote its entire report to stderr, and Vitest used both streams. Through the compiled filter, merged Jest output was reduced by 40 `PASS` lines (1,624 to 964 characters), and `--verbose` by 120 lines (2,824 to 1,026). `npm test` behaved the same. Default Vitest 5 output lists only failures and totals, so the adapter found nothing to remove. `--reporter verbose` removed 40 `✓` lines and kept `×` (2,175 to 1,164). The docs now say that both agents merge stderr into the filtered text, and note the Vitest 5 behaviour. Real Claude/Codex hook delivery was not exercised, since no paid sessions were run.


## Docs site follow-ups: hero performance, stylesheet split and visualiser layout

- **Hero:** the effect no longer writes a CSS variable each frame. Before, that forced a style recalculation, layout and panel repaint on every frame of pointer movement. The gate label now moves with a compositor-only transform, the canvas position is cached, uniform locations are looked up once, pixel density is capped at 1.5x, and resolution steps down when frames stay slow. In headless Chrome with software rendering, 3 seconds of simulated pointer movement went from 29 forced layouts to 2, and from 29 to 72 frames. Real GPU frame rates were not measured.
- **Stylesheet:** the single compact stylesheet is now 13 readable files in `site/src/styles/`. `main.css` lists them, and the build inlines them into one `styles.css`, failing on unlisted parts. A rule-by-rule comparison found the same 201 rules (selectors, declarations and media queries) before and after.
- **Visualiser layout:** wide screens (1200px and up) use a 1,520px page with Observation and Model receives in a wide main column and a sticky checks sidebar. Medium widths stack the cards and show checks as tiles, and phones use one column. Output and input lines wrap with a hanging indent instead of scrolling sideways. Runs of removed lines collapse into a summary row when "show removed" is off, which is the default on phones. QA at 390, 900, 1440 and 1920px found no page or pane overflow.
- **Mobile dock and copy buttons:** below 960px a floating section pill with a scroll-progress ring opens a sheet of the page's sections and the site links. It replaces the wrapped section list and, on phones, the second nav row. It works as a modal dialog with Escape, a focus trap and focus return. On phones, copy buttons show only an icon until a copy succeeds ("Copied") or fails ("Copy failed").
- **Site scripts:** the four large scripts are now 22 small modules under `site/src/js/`: shared page modules, `hero/` and `visualiser/`. The build copies them unchanged and fails on any relative import of a missing file, which a probe confirmed. A regression pass covered the hero, tabs, copy success and failure, every visualiser mode, level and sample path tested before, editing, recovery slices, the sticky controls and the dock. It found and fixed two issues. Live-region announcements waited on an animation frame, which a busy hero frame loop could delay, so they now use a short timer. The visualiser packet could rest a few pixels off its dot after a layout shift, so it now re-aligns when the checks list resizes. The format explanation now also recognizes pytest, Jest and Vitest commands.


## Docs site migrated to Astro Starlight

`site/` is now an Astro Starlight project (Astro 7.4.2, Starlight 0.42.7, `@astrojs/markdown-remark` 7.3.4, pinned, each at least two weeks old). It is a separate npm project with its own `site/package-lock.json` and is not a root workspace, because the Homebrew runtime runs `npm ci --omit=dev` against the root lockfile. The root lockfile is unchanged, and the release archive contains no `site/` files.

- **Pages:** a splash landing page with the WebGL hero, then Start here, Filtering, Configuration and Help, plus the visualiser at `/how-it-works/`. The guides in `docs/` are synced into a Reference section at build time with rewritten links, so `docs/` stays the single source. Starlight adds search (Pagefind), the sidebar, "On this page" and a theme switch.
- **Overrides:** `Hero` (WebGL panel), `SocialIcons` ("Star on GitHub"), and `Head`, which attaches the section dock with the page headings and docs navigation as JSON. Starlight renders its mobile menu and table-of-contents bar only on pages with a sidebar or contents, so both are overridden with empty components and the dock covers every page below 72rem, with a theme switch.
- **Build checks:** `scripts/prepare-content.mjs` syncs the guides and checks all 11 samples at all three levels against the compiled filter. `scripts/check-links.mjs` fails on any dead internal link or anchor. The profile table and demos are rendered from the compiled core, and the visualiser bundles the compiled filter with a browser stub for the archive module.
- **Wiring:** `npm run docs:build` and `docs:dev` compile the core and then run the site. The Vercel install command also runs `npm ci --ignore-scripts --prefix site`, and CI installs the site before building it. The old hand-written build and preview scripts are removed.

A clean `npm ci --ignore-scripts --prefix site` (0 vulnerabilities) and `npm run docs:build` built 21 pages and passed the link check. `npm run check` passed with all 76 offline tests, and the cask checksum was regenerated for the README change. Browser QA at 1440px and 390px covered the hero, the docs pages, the visualiser (filtering, sticky controls, monospace output, alignment) and the dock (sheet, focus, Escape, theme switch, pages without sections). Remaining build warnings are expected: no `site` URL exists yet for the sitemap, and Starlight's own 404 route supersedes the duplicate catch-all render.

**Agent CLIs on request.** The parent delegation guidance said "Never spawn headless fonn, claude, or codex subprocess workers". Claude read that as a ban even when the user explicitly asked it to work with Codex. The guidance now asks agents not to start other agent CLIs on their own initiative. When the user explicitly asks, the agent may run one as an ordinary command (for example `codex exec`) through the normal approval prompt. It also states that `fonn codex` and `fonn claude` are interactive and cannot be driven from a tool call. The worker notice has the matching exception. The ban on widening permissions or allowlists to retry a rejected delegation is unchanged, and Fonn itself still launches no workers. The subagents guide, README and site FAQ explain the workflow. All 76 offline tests passed with the updated assertions. Real model behaviour with the new wording was not exercised.


## Zod security update and install order

`npm audit` reported a high-severity zod advisory: versions below 4.6.6 can exhaust memory while validating oversized constrained collections. zod is a runtime dependency of the core and the CLI, and it is shared with the Claude Agent SDK. Both pins moved from 4.1.12 to 4.6.7, a non-major release from 2026-10-12. The lockfile now resolves a single zod 4.6.7 for every dependent, and `npm audit --omit=dev` reports no vulnerabilities. The release preparation pin and its packaging test fixtures were updated, and the zod license notice is unchanged. `npm run check` passed with all 76 offline tests. A regenerated release archive was installed the way the cask does it (`npm ci --omit=dev --ignore-scripts`) in a scratch directory: 107 packages, no vulnerabilities, and the CLI ran offline. `Casks/fonn.rb` carries the new checksum. The site already used zod 4.6.7 through Starlight.

The docs site's install page now orders the routes by ease of use: Homebrew (awaiting the first release, with a pointer to the source route), source checkout, then standalone filters.


## Docs site publication and delivery

| Task | State | Evidence |
| --- | --- | --- |
| Phone readability | DONE | Sample tabs stay on one line, original output starts collapsed on phones, the dock sheet separates group labels from links, and sideways-scrolling rows fade only at edges with more content (PR #5). |
| Custom theme menu | DONE | Starlight's native theme select is replaced by a custom listbox shared with the dock (PR #6). Browser QA covered mouse and keyboard use, Escape, outside clicks, persistence and dock sync. |
| Repository links | DONE | Header and dock links read "Star us" with the GitHub mark (PR #7). The `nord-forge` organization links to https://nickbevers.dev, and the repository website is https://fonn.nord-forge.dev. |
| Publication | DONE | Vercel project `fonn` on the maintainer's personal account serves https://fonn.nord-forge.dev with a Let's Encrypt certificate, HTTP to HTTPS redirects and a sitemap (PR #4). A separate `nord-forge-redirect` project sends `nord-forge.dev` and `www.nord-forge.dev` to https://nickbevers.dev with permanent 308 redirects. |
| Manual prebuilt deploys | DONE | `npm run docs:deploy` builds locally and uploads with `vercel deploy --prebuilt`, and `-- --preview` makes a preview (PR #8). `vercel.json` disables Vercel's Git builds; PR #8 showed no Vercel check and its merge started no Vercel build. A preview from the branch and the production deploy of `93aa711` both became ready, and the build ran on Node 24 to match CI. |

Command accuracy was checked by running the documented routes from scratch. A fresh `git clone`, `npm ci --ignore-scripts` (no vulnerabilities), `npm run build` and `--help` all worked. The five-file standalone download from `main` fetched every file, and `hook.mjs --help` showed the `--level` option. Live production pages returned 200 for anonymous visitors. Delivery screenshots of the live site were taken at 1440px (landing page and visualiser) and 390px (install page). Homebrew installation remains unverified until the first release archive and matching cask are published. No paid model calls were made.


## Fonn 0.1.0 released

The release notes were brought up to date first (PR #10). The notes are not part of the archive, so the checksum stayed the same. On `749ffe7`, `npm run release:prepare` produced an archive whose SHA-256 (`1f83d265…`) matched `SHA256SUMS` and the committed `Casks/fonn.rb`. The archive held 47 files of Fonn code, lockfiles, licenses and a name-and-version marker, with no dependencies, env files, local state or site files. `v0.1.0` was tagged on `749ffe7` and published as a non-draft GitHub release with `fonn-0.1.0.tar.gz` and `SHA256SUMS`. The asset downloaded from the cask's URL matched the cask checksum.

On the maintainer's Mac, `brew tap nord-forge/fonn https://github.com/nord-forge/fonn` and `brew install --cask nord-forge/fonn/fonn` installed Homebrew Node 26.13, ran the runtime installer (107 locked packages) and linked `/opt/homebrew/bin/fonn`. Offline commands worked: `--version` (0.1.0), `--help` with filter levels, `--default-filter-level`, `profiles` and `doctor`. A shell alias named `fonn` takes priority over the installed command, as the docs note. No paid model calls or native agent launches were made with the installed build. The docs now describe Homebrew as available, and `Casks/fonn.rb` stays pinned to the published archive until the next version.


## Project settings (fonn ui phase 1)

The first step towards the `fonn ui` management interface is per-project settings in the core (`@nord-forge/fonn-core/settings`), shared by the CLI now and the UI later. `.fonn.json` is shared and committed, and `.fonn/settings.local.json` is personal. They hold four keys: `profile`, `filterLevel`, `filterMode` and `subagents`. Unknown keys, invalid values, bad JSON, oversized files and symlinks are rejected. Precedence is flag, personal file, shared file, global default, then built-in default. Native launches and new `fonn run` tasks use it, and print a notice for project-sourced values. An explicit `fonn claude` or `fonn codex` ignores a project profile for the other agent with a note, while a mismatched flag stays an error. SDK resume still reads no settings files. `fonn config show|get|set|unset` edits the files: personal by default, `--shared` for the team. It warns when `.fonn/` is not ignored by Git and when a shared profile is custom.

Global values for all four keys are saved in `~/.config/fonn/profiles.json` with `fonn config set|unset <key> --global`. A value is labelled a global default only once saved; otherwise the built-in default applies. `npm run check` passed with 79 offline tests, on Node 24 and on Homebrew's Node 26.13: one new core case (discovery, precedence, validation, atomic writes, symlink refusal) and two new CLI cases (config commands, project-driven launch, the provider fallback, unknown profiles, invalid values; global values, project and flag overrides, unsetting). A smoke test of the built CLI in a scratch Git project showed the expected sources and the `.gitignore` warning. The docs site has a project settings guide. `Casks/fonn.rb` stays pinned to the published 0.1.0 archive.


## CI runs once per pull request

Pushes to pull request branches started two identical CI runs, one for `push` and one for `pull_request`. That made four macOS jobs per push. On busy afternoons they queued without a runner and GitHub cancelled them after about 15 minutes, with no steps run, so a run showed as failed while every Linux job passed. CI now runs `push` only for `main`, gives each pull request one run, and cancels an older run of the same branch or pull request when a newer push arrives. Runs on `main` are never cancelled. The required check names are unchanged.

## Fonn UI and filter rules (fonn ui phases 2 and 3)

`fonn ui` starts a local web interface inside the CLI. It changes global and project settings, edits profiles and filter rules, runs a test bench, and shows launches, SDK runs, filter decisions and archived originals. It listens on `127.0.0.1` only. A per-start 32-byte token is exchanged for an HttpOnly, SameSite=Strict cookie. Requests need an allowed Host, and changes also need a matching Origin, `X-Fonn-Request: 1` and JSON. Bodies are capped at 64 KB, or 512 KB for the test bench. Responses send a strict CSP with `frame-ancestors 'none'`. Archived originals are sent in slices of at most 20,000 characters, instruction files come from a fixed list, and symlinks are refused. The web assets are bundled into a generated module at build time, so the release archive needs no new file types. The server and API were written by a Claude subagent and the interface by Codex. Both were reviewed and integrated here.

User filter rules are plain-text "remove lines containing" matches for commands with a given prefix. They are validated by `filterRulesSchema` and merged from global, shared and personal settings. They never remove lines about problems or security, and each run of removed lines leaves a note. Launch records, resume and SDK runs keep the rules they started with. Project files can be written by anyone who can commit, so their rules only apply once approved with `fonn config approve-rules` or in the UI. The approval is stored against a fingerprint in the global config and lapses when the rules change. Deleting a launch without a recorded finish needs confirming. Saving a project file that changed on disk since the page loaded is refused with a 409, so a pull or an agent's edit is never silently undone.

`npm run check` passed with 90 offline tests. That covers rules and approval in the core, the server's read and change endpoints with their guards, and the web interface's request and validation helpers. Headless Chrome QA on synthetic demo data covered these flows at 1440px: approving project rules, saving a global setting, adding a global rule with validation errors, a test bench run (120 lines removed, the vulnerability line kept), creating a profile and deleting a launch. Every page was also checked at 360px with no horizontal scrolling. A CLI smoke test showed approval lapsing after a rule changed. No real records, paid model calls or agent launches were used. `Casks/fonn.rb` stays pinned to the published 0.1.0 archive.


## macOS checks run locally

Hosted macOS jobs kept failing without running a step. They queued for about 15 minutes and were then cancelled, while every job that got a runner passed. CI now runs only on Linux, with Node 22, 24 and 26. `npm run check:mac` runs the same six CI steps on the maintainer's Mac for Node 24 (nvm) and Node 26 (Homebrew). Each version gets a fresh clone of the current commit in a temporary folder, so uncommitted changes never count. `-- --report` refuses a dirty tree or an unpushed commit and posts `local/macos (Node 24)` and `local/macos (Node 26)` commit statuses with the gh CLI. The `main` ruleset requires the Node 24 status in place of the hosted macOS check. A self-hosted runner was ruled out because the repository is public.

## Built-in profiles for every listed Codex model

Codex 0.167's model catalog lists eight visible models. Each now has a built-in profile at medium effort. `codex:sol-medium` (`gpt-6.1-sol`) stays the Codex default. The newest model of each other family gets a short name (`codex:terra-medium`, `codex:astra-medium`, `codex:luna-medium`), and older versions name their model (`codex:gpt-6-sol-medium`, `codex:gpt-5.6-sol-medium`, `codex:gpt-5.6-terra-medium`, `codex:gpt-5.6-luna-medium`). The two hidden catalog entries, `gpt-reserve` and `codex-auto-review`, are left out. A new core test pins the list to the catalog and checks that each profile validates. `npm run check` passed with 80 offline tests, and the docs site's generated profile table lists all eight. No model calls were made.

## Open models through Codex

A Codex profile can now have a `source`: `ollama` or `lmstudio` runs a local model through `codex --oss --local-provider`, and `provider:<name>` uses a model provider from the user's own `~/.codex/config.toml` with `-c model_provider`. With a source, the model may be any name that source uses. Fonn stores only the provider name and never reads or passes provider credentials. `fonn profiles create|edit --source` sets it, and `--source openai` removes it. A new guide, `docs/open-models.md`, covers setup and what differs between models. Offline tests cover the schema (Codex only, allowed names, rejected sources) and the exact Codex arguments for both kinds of source. No real local or hosted model has been run yet.

## The standalone filter for Crush, OpenCode and Ollama

People who run open models with Ollama and an open-source agent can now use the standalone filter without Claude Code or Codex. `hook.mjs` accepts `--provider crush` and `--provider opencode`. Both take the lowercase `bash` tool name and a plain string `tool_response`, and return `{"updated_output": "..."}`, or `{}` when nothing changes or anything fails. Claude and Codex input and output are unchanged. Originals are archived under a separate namespace per agent and stay readable with the footer's `read` command. `standalone/filtering/opencode-plugin.js` is a hand-authored OpenCode plugin for the v1.19.5 `tool.execute.after` hook. For the `bash` tool it runs `hook.mjs` with Node and replaces `output.output`. On any error, or after 5 seconds, it leaves the output alone. It finds `hook.mjs` next to itself or through `FONN_FILTER_HOOK`, and uses Node builtins only. The generated modules did not change.

The Crush payload and output were checked against `docs/hooks/README.md` and `internal/agent/tools/bash.go` on Crush `main`. The OpenCode hook, loader and shell tool were checked against the v1.19.5 tag: `packages/plugin/src/index.ts`, `packages/opencode/src/session/tools.ts`, `packages/opencode/src/config/plugin.ts`, `packages/opencode/src/plugin/index.ts` and `packages/opencode/src/tool/shell/id.ts`. OpenCode only loads `.js` and `.ts` files from a plugin folder and treats every export as a plugin, so the plugin file exports one function. Neither agent was run.

A new guide, `docs/other-agents.md`, covers Crush and OpenCode with Ollama, Claude Code against Ollama's Anthropic API, model and context tips, and the agents whose hooks cannot replace output. `npm run check` passed with 96 offline tests (44, 46 and 6). The new packaging case covers filtered, unchanged and malformed input for both providers, a kept failure line, recovery through the footer, the plugin with a stubbed spawn (mutation, five failure shapes, a timeout, a skipped tool) and one run of the plugin against the real hook. `npm run docs:build` built 25 pages and passed its link check. No model calls were made.


## fonn chat, a small agent for open models

`fonn chat` talks to Ollama, LM Studio or any OpenAI-compatible server, without Claude Code or Codex. The core (`@nord-forge/fonn-core/agent`) has a streaming chat client, six tools (`run_command`, `read_file`, `list_files`, `write_file`, `edit_file`, `read_original`) and the loop. Commands, writes and edits always ask through the host, and "always" only covers the exact command or file for that session. Reads inside the project need no approval, and symlinks cannot leave the project silently. Command output goes through the usual filter with the project's settings and approved rules, and originals are archived for `read_original`. Older tool output is shortened first when the conversation nears the context limit. The terminal side streams replies, shows thinking dimmed, and shows commands in full before asking, so nothing hides behind a harmless first line. The core was built by a Claude subagent and the terminal by Codex, against one contract.

`npm run check` passed with 141 offline tests. With Qwen3.8-27B UD-IQ3_XXS on Ollama 0.40.16, a real session listed a folder after one approval and answered correctly in about 950 tokens of context, against about 73,000 for the same task in Codex. A command that printed 400 near-identical lines reached the model as 357 of 25,892 characters at the similar level, with the original archived. No hosted model was called.
