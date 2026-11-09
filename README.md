# Fonn

A local TypeScript CLI and reusable core for Claude and Codex, with structured task execution through the Claude Agent SDK. Run `fonn` to open the native CLI selected by your default profile, or `fonn run` to start a structured SDK task with estimated usage accounting. Recognized noisy tool output can be shortened conservatively while originals remain recoverable.

This is the `nord-forge/fonn` monorepo. The current product is the core and CLI. A desktop GUI is reserved for later; no desktop app is implemented. Project code is [MIT licensed](LICENSE); upstream dependencies retain [their own terms](THIRD_PARTY_NOTICES.md). Fonn is independent of Anthropic and OpenAI.

## Get the CLI or reuse a script

The CLI is ready to run from a checkout; the GUI is planned. If you want to inspect or reuse a specific part, go straight to its source:

| Script / entrypoint | Purpose |
| --- | --- |
| [CLI entrypoint](packages/cli/src/cli/main.ts) · [raw](https://raw.githubusercontent.com/nord-forge/fonn/main/packages/cli/src/cli/main.ts) | Commands, help, profiles, provider selection and task dispatch. |
| [Claude launcher and hook](packages/cli/src/native/index.ts) · [raw](https://raw.githubusercontent.com/nord-forge/fonn/main/packages/cli/src/native/index.ts) | Per-launch Claude settings and recoverable output filtering. |
| [Codex launcher and hook](packages/cli/src/native/codex.ts) · [raw](https://raw.githubusercontent.com/nord-forge/fonn/main/packages/cli/src/native/codex.ts) | Native Codex launch settings and its post-tool adapter. |
| [Output filter](packages/core/src/filtering/index.ts) · [format adapters](packages/core/src/filtering/adapters.ts) | Conservative reductions for recognized noisy shell output. |
| [Release preparation](scripts/release/prepare.mjs) · [raw](https://raw.githubusercontent.com/nord-forge/fonn/main/scripts/release/prepare.mjs) | Build the archive, checksum and matching cask after compilation. |
| [Homebrew runtime installer](packaging/homebrew/runtime.mjs) · [command launcher](packaging/homebrew/launcher.mjs) | Install locked runtime dependencies and start the staged CLI. |

These source files use the repository's modules and dependencies. For a working CLI immediately, use the checkout below; individual entrypoint downloads are not standalone executables:

```sh
git clone https://github.com/nord-forge/fonn.git
cd fonn
npm ci --ignore-scripts
npm run build
node packages/cli/dist/cli/main.js --help
```

Then run `node packages/cli/dist/cli/main.js claude` or `node packages/cli/dist/cli/main.js codex` from your project with `--cwd /absolute/path/to/project`. The [Homebrew instructions](docs/distribution.md#first-publication-and-homebrew) cover release installation once the archive is published.

## Local setup

Use Node 22 or later; CI uses Node 24. From the repository root:

```sh
npm ci
npm run check
node packages/cli/dist/cli/main.js --help
node packages/cli/dist/cli/main.js profiles
node packages/cli/dist/cli/main.js doctor
```

`check` runs typechecking, mocked tests, and a build across the workspaces. Checks never make paid model calls. Dependency installation downloads packages, but does not authenticate to or call a model. `doctor` is offline: it checks Node compatibility, API-key presence, and configuration compatibility, not credential validity, model access, or billing. A missing key makes it exit nonzero, even if you only intend to use native Claude.

| Workspace | Responsibility |
| --- | --- |
| `packages/core` · `@nord-forge/fonn-core` | Contracts, profiles, schemas, filtering, artifact recovery, SDK runtime. |
| `packages/cli` · `@nord-forge/fonn-cli` | CLI parsing, native Claude and Codex launch services, terminal rendering, approval and question input. |
| `apps/desktop` | Documentation placeholder for a future GUI using the core. |

The repository root is a private workspace coordinator; that flag does not make the GitHub repository private. Package names identify workspace imports and do not imply the packages have been published to npm. Root `dist/cli/main.js` remains a local development compatibility shim; use the canonical entrypoint above for new integrations.

## Homebrew CLI cask

The repository includes CLI release preparation and a cask for macOS. **Installation is not available until the first GitHub release archive and matching checked-in cask have been published.** The following commands are for that future published state:

```sh
brew tap nord-forge/fonn https://github.com/nord-forge/fonn
brew install --cask nord-forge/fonn/fonn
fonn --help
fonn --cwd /absolute/path/to/project --profile opus-medium
```

This explicit tap URL uses the same repository, including its `Casks/` directory; there is no separate `homebrew-*` repository. The CLI cask depends on Homebrew Node and fetches locked runtime dependencies on your machine. The release archive contains no `node_modules` or bundled Anthropic SDK. It does not install a GUI. See [distribution and release preparation](docs/distribution.md).

If you have a shell alias named `fonn`, it can shadow the installed command. Inspect it with `type -a fonn`. To use the installed command in your current shell, run `unalias fonn` if it is an alias; manually remove the alias from your shell configuration for future shells. Installation does not edit that configuration.

## Open interactive Claude

Install and authenticate ordinary Claude Code 2.1.319 or newer separately, then run locally:

```sh
node packages/cli/dist/cli/main.js --cwd /absolute/path/to/project --profile opus-medium
node packages/cli/dist/cli/main.js --filter observe -- --resume
```

After Homebrew installation, run `fonn claude` in your project, or `fonn claude --cwd /absolute/path/to/project`. Bare `fonn` also opens Claude while your selected/default profile belongs to Claude; a Codex profile selects Codex instead. The launcher opens the unmodified interactive Claude CLI with its own terminal UI, authentication, permissions, settings, and questions. A profile, compact tool display, and output-filter hook apply to that launch; global Claude settings are not automatically changed. Billing follows ordinary Claude's active authentication, including any API key in the environment. Subscription billing is not guaranteed. SDK budgets, turn limits, structured results, and usage accounting do not apply to native launches.

Tool details start collapsed; press **Ctrl+O** to expand them or use `fonn -- --verbose` for verbose display. Collapsing does not reduce model-input tokens. See [MCP output and context limits](docs/mcp-output.md) for the separate large-result offload option.

Pass ordinary Claude arguments after `--`. Options that override the selected launch model/effort, hook/settings sources, or permission policy are rejected, including permission-bypass flags. Management and cloud subcommands are unsupported through this launcher; use plain `claude` for those. The profile sets the initial model and effort; interactive `/model` and `/effort` remain available. Launch IDs and state locations are recorded for original-output recovery. `native-hook` is an internal stdin-JSON command used by generated hook settings.

## Open interactive Codex

Install and authenticate the Codex CLI separately, then run:

```sh
fonn codex
fonn profiles create sol --provider codex --model gpt-6.1-sol --effort medium
fonn codex --profile sol
```

Codex retains its existing authentication, settings, approval and sandbox policies. New Fonn hooks require review in Codex's `/hooks` browser before filtering can run; Fonn never bypasses hook trust. The native interface remains Codex's own UI. See [Codex support](docs/codex.md), including filtering limits and recovery. Programmatic `fonn run` remains a Claude SDK command.

## Custom profiles

Save a provider, model and effort choice, then use it for the matching native CLI. Claude profiles also work with SDK tasks:

```sh
fonn profiles create focused --model sonnet --effort medium
fonn profiles default focused
fonn profiles
fonn --profile focused
```

Use `fonn help profiles` for create, edit, show, delete, and default commands. A Codex default makes bare `fonn` open Codex; `fonn claude` and `fonn codex` explicitly select a provider. Profiles are stored locally in `~/.config/fonn/profiles.json`, with `XDG_CONFIG_HOME` and `FONN_CONFIG_DIR` overrides. Built-in profiles remain unchanged. Saved SDK tasks keep their original profile snapshot when resumed, even after edits or deletion. See [profiles](docs/profiles.md).

## Run an SDK task

Supply your own `ANTHROPIC_API_KEY` through your environment or normal secret manager. SDK runs use separate API billing and do not extract subscription credentials or use subscription quotas. This example makes paid model requests:

```sh
node packages/cli/dist/cli/main.js run "Explain the failing tests and propose a fix" \
  --cwd /absolute/path/to/project --profile opus-medium \
  --budget 2 --max-turns 15 --filter observe
```

Permissions continue through the SDK and the target project's user, project, local, and managed settings. When approval is needed, the CLI displays the untrusted tool input on stderr and requires `yes` in an interactive terminal. Noninteractive approval requests are denied. Existing rules that already allow a tool still apply; there is no permission bypass flag. See [authentication, estimates, and budgets](docs/billing.md).

The commands below use the installed `fonn` name. In a local checkout, substitute `node packages/cli/dist/cli/main.js`.

| Command | Purpose |
| --- | --- |
| `[launcher options] [-- <native args>]` | Open the native CLI selected by the chosen/default profile. |
| `claude [options] [-- <claude args>]` | Open native Claude with a Claude profile. |
| `codex [options] [-- <codex args>]` | Open native Codex with a Codex profile. |
| `profiles [--json]` | List built-in and custom profiles, marking the default. |
| `run <prompt> [options]` | Start a task or continue with `--resume <task-id>`. Quote the prompt as one argument. |
| `runs [--state-dir <path>] [--json]` | List saved SDK runs. |
| `show <task-id> [--state-dir <path>] [--json]` | Read results, checks, estimates, and filtering statistics. |
| `output <task-id> <artifact-id> [--offset <n>] [--limit <n>] [--state-dir <path>]` | Recover a bounded slice of original SDK output. |
| `native-output <launch-id> <artifact-id> [--offset <n>] [--limit <n>] [--state-dir <path>]` | Recover original output from an interactive launch. |
| `doctor [--json]` | Check local compatibility and key presence offline. |
| `--help`, `--version` | Print usage or package version offline. |

SDK options include `--cwd`, `--profile`, `--budget`, `--max-turns`, `--filter`, `--state-dir`, `--resume`, and `--json`. New SDK tasks require a Claude profile; select one explicitly if your global default is Codex. Otherwise defaults are the configured profile (initially `opus-medium`), an estimated $5 stop threshold, 20 turns, and conservative `filter` mode. Requests may overshoot the threshold. Profiles are fixed for an SDK task; resume retains the saved profile and project directory. `observe` records potential reductions without changing delivered output; `off` disables reduction.

`--json` reserves stdout for one machine-readable value on successful dispatch; progress, permissions, and errors use stderr. Errors may leave stdout empty. Failed, cancelled, budget-stopped, invalid, and failed-check outcomes exit nonzero. Ctrl+C requests cancellation; a saved cancelled outcome is shown when the runtime can produce one. Human-readable model/tool text escapes terminal controls.

## Records and recovery

Fonn records and artifacts default to `~/.local/state/fonn`; use `--state-dir` for a dedicated location. Prompts, paths, tool responses, and source fragments can be private. Keep this state out of commits and release archives. Retention is manual. Claude and SDK sessions may also use Claude's own storage.

```sh
fonn runs --json
fonn show <task-id>
fonn output <task-id> <artifact-id> --offset 0 --limit 4000
```

Recovery defaults to 4,000 characters and allows at most 20,000 per request. Continue with the reported next offset. Stored originals remain intact; displayed controls are escaped. Recovery stays within the current task store and validated same-session/project ancestors. For CLI recovery, name the task that stored the artifact. See [filtering](docs/filtering.md) and [temporary-state examples](examples/local-workflow.md).

Resume accepts only the latest saved task for a session and holds an owner-checked session lock through saving the next record. Competing resumes are rejected before another SDK query. After a crash, a lock may remain under `resume-locks/` in the chosen state directory. The rejection identifies it. Inspect its owner token, process ID, and creation time, and verify that the original process and SDK session have ended before manually removing that specific lock. Age or a process ID alone is insufficient; the application does not remove competing or stale locks automatically.

If cumulative SDK usage counters reset, the run fails with indeterminate accounting and retains reported counters as observations. Start a fresh task without `--resume`; the reset is not reported as a free continuation.

Output-reduction benchmarks motivated this experiment. They do not promise 60% savings, equivalent accuracy, or lower costs on real tasks. Character reduction is not token or dollar reduction.

## References

See [architecture](docs/architecture.md), [distribution](docs/distribution.md), and Anthropic's official [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), and [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) documentation. The pinned dependency and implementation define Fonn's supported behavior.
