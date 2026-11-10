# Download the filter and use it locally

You can use Fonn's output filter in an existing Claude Code or Codex project without installing the Fonn CLI, npm packages, or either provider's SDK. Download four JavaScript modules and their MIT license; the only runtime requirement is Node.js 22 or later. Install and authenticate your normal agent separately. These hooks use the same supported baseline as Fonn: Claude Code 2.1.319+ or Codex CLI 0.167.0+. For Crush, OpenCode or Claude Code with Ollama, see [Use the filter with Ollama and other agents](other-agents.md).

From your project's root, download the files together:

```sh
mkdir -p scripts/fonn-filter
curl -fL https://raw.githubusercontent.com/nord-forge/fonn/main/standalone/filtering/hook.mjs -o scripts/fonn-filter/hook.mjs
curl -fL https://raw.githubusercontent.com/nord-forge/fonn/main/standalone/filtering/index.mjs -o scripts/fonn-filter/index.mjs
curl -fL https://raw.githubusercontent.com/nord-forge/fonn/main/standalone/filtering/adapters.mjs -o scripts/fonn-filter/adapters.mjs
curl -fL https://raw.githubusercontent.com/nord-forge/fonn/main/standalone/filtering/artifact-store.mjs -o scripts/fonn-filter/artifact-store.mjs
curl -fL https://raw.githubusercontent.com/nord-forge/fonn/main/standalone/filtering/LICENSE -o scripts/fonn-filter/LICENSE
node --version
node scripts/fonn-filter/hook.mjs --help
command -v node
```

`main` changes over time. For a reviewed, repeatable download, replace `main` in all five URLs with the same reviewed commit SHA. Read the downloaded files before enabling them. The three generated filter modules come directly from the core build; `hook.mjs` handles native hook input and local recovery. No model calls occur in these scripts.

## Ask your agent to set it up

After downloading, paste this instruction into Claude or Codex:

```text
Read scripts/fonn-filter/{hook,index,adapters,artifact-store}.mjs and its LICENSE, then set up this local output filter for the agent I am using. Use Node 22+ and absolute, correctly shell-quoted paths for the Node executable, hook.mjs and this project's .fonn/filtering state directory. Use filter mode (or observe if I request it). Merge one Bash PostToolUse command hook into .claude/settings.local.json for Claude, or .codex/hooks.json for Codex. Preserve every existing hook, permission, policy and other setting; do not change global settings. Do not install Fonn, npm packages or SDKs. Add .fonn/ to this project's .gitignore if it is not already covered. Explain how I can recover originals with the footer's read command, how observe/off work, and that raw output can be private and needs manual retention. For Codex, leave hook review and trust to me in /hooks; never bypass it or write a trust decision. Do not invoke a model to test the filter. Show the final local changes and any remaining manual step.
```

## Configure Claude Code

Merge the following into your existing `.claude/settings.local.json`. Replace `/absolute/path/to/node` with the executable reported by `command -v node`, and `/absolute/project` with your physical project directory. Keep single quotes around each absolute path so spaces are handled. A literal single quote inside a path needs POSIX shell escaping (`'\''`) and JSON escaping of the backslash; ask your agent to generate that command rather than hand-editing it.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "'/absolute/path/to/node' '/absolute/project/scripts/fonn-filter/hook.mjs' hook --provider claude --mode filter --state-dir '/absolute/project/.fonn/filtering'",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

This is a merge example, not a replacement for an existing settings file. Review the resulting project hook in Claude's normal hook/settings interface. Permissions remain with Claude's existing configuration.

## Configure Codex

Merge the same JSON into project `.codex/hooks.json`, changing only `--provider claude` to `--provider codex`. Preserve existing hooks and other configuration. Codex discovers project hook files alongside its configuration layers; open `/hooks` and review and trust the exact command yourself. A changed hook may require another review. Until trusted, filtering is inactive. See the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).

## Modes and recovery

`--mode filter` replaces only a recognized noisy Bash observation and includes a recovery command. `--mode observe` archives originals for proposed reductions and returns `{}`, leaving the delivered observation intact. `--mode off` returns `{}` without accessing filter state. Change the hook command's mode or remove only this hook to disable it. In Codex, review the changed definition again when required.

The filter recognizes conservative Pest/PHPUnit, PHPStan and pytest progress lines, Jest and Vitest passing-test lines, and adjacent identical TypeScript diagnostics. For any other command it collapses runs of three or more identical adjacent lines to one copy and a count. The hook command's `--level` chooses how far it goes: `strict` uses the format adapters only, `standard` (the default) adds identical lines, and `similar` also collapses runs of lines that differ only in numbers or IDs, keeping the first and last. See [filter levels](filtering.md#filter-levels). It preserves failures, warnings, stderr, exit status and unknown response fields. Other unknown output, MCP tools and unsupported response shapes pass through. It only processes new shell output: it does not edit model thinking, conversation history, instructions or source files. Collapsed terminal output is separate from model-input reduction. Real model-token and billing savings have not been measured.

Filtered output contains an exact, shell-quoted recovery command using your Node executable, script path, state directory, store key and artifact ID. Run that command to retrieve JSON containing a bounded slice of the original serialized response:

```sh
'/absolute/path/to/node' '/absolute/project/scripts/fonn-filter/hook.mjs' read STORE_KEY ARTIFACT_ID --state-dir '/absolute/project/.fonn/filtering' --offset 0 --limit 4000
```

Use the actual 64-character store key and UUID from the footer, and continue with the returned `nextOffset` until it is `null`. Reads default to 4,000 characters and allow at most 20,000; `text`, `offset`, `nextOffset` and `totalCharacters` describe the serialized original JSON. Combining slices exactly restores that JSON, including response metadata. Observe mode has no footer because it leaves output unchanged; its stored originals can be inspected manually under the chosen state directory.

State defaults to `.fonn/filtering` under the hook process's working directory, but absolute `--state-dir` paths keep hooks and recovery consistent. Each provider, canonical project directory and session ID gets a separate SHA-256 namespace. Missing valid session/project fields, unsupported events and runtime errors fail open with the original observation retained. State paths containing symlinks are rejected, including symlinked parents; use physical absolute paths. These checks use Node's path APIs and do not provide protection against a hostile process racing directory replacements.

Original responses are stored atomically as private files (`0600`) in private namespace directories (`0700`). Raw output can contain credentials, logs or private project data; filtering does not redact it. Keep `.fonn/` out of Git and release archives. Retention is manual: inspect and remove only the state you intend to delete after it is no longer needed. The scripts do not read transcripts, authentication files, arbitrary recovery paths, or previous sessions automatically.

## Maintain the downloaded modules

In the Fonn checkout, `npm run build` compiles the core and regenerates the three standalone modules and license through `scripts/build-standalone-filter.mjs`. Edit the shared TypeScript filter sources rather than the generated `.mjs` files. `hook.mjs` is the small hand-authored native wrapper, and `opencode-plugin.js` is a hand-authored OpenCode plugin that calls it. The focused packaging test runs these five files in a dependency-free temporary directory with mocked tool responses.
