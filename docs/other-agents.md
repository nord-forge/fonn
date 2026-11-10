# Use the filter with Ollama and other agents

This guide is for people who run open models with [Ollama](https://ollama.com) and an open-source coding agent, without Claude Code or Codex. Fonn's standalone output filter works with two such agents today, [Crush](https://github.com/charmbracelet/crush) and [OpenCode](https://github.com/anomalyco/opencode). Both let a hook replace a command's output before the model sees it. You also need Node.js 22 or later. You do not need the Fonn CLI, npm packages or any SDK.

The filter behaves as it does for Claude and Codex. It shortens recognized noisy shell output, keeps warnings, failures and unknown lines, and archives the original so the model can read it back. See [Download the filter and use it locally](local-filtering.md) for what it recognizes, the modes and the state directory. Nothing in these scripts calls a model.

## Download the files

Download the filter folder from your project's root. It holds the same files as in the [local setup guide](local-filtering.md), plus the OpenCode plugin:

```sh
mkdir -p scripts/fonn-filter
curl -fsSL https://codeload.github.com/nord-forge/fonn/tar.gz/main \
  | tar -xz -C scripts/fonn-filter --strip-components=3 fonn-main/standalone/filtering
node scripts/fonn-filter/hook.mjs --help
command -v node
```

To pin a reviewed commit, replace `main` in the URL and `fonn-main` in the path with that commit's full SHA, for example `fonn-<sha>`. Read the files before you enable them. Add `.fonn/` to your `.gitignore`, because archived originals can hold private output.

## Crush

Crush runs [hooks](https://github.com/charmbracelet/crush/tree/main/docs/hooks) as shell commands. A `PostToolUse` hook gets the `bash` tool's output as one string on stdin and can return `{"updated_output": "..."}` to replace it. `hook.mjs` does that with `--provider crush`.

Add the hook to your project's `.crushrc`. Use absolute, single-quoted paths, with the Node path from `command -v node`:

```bash
provider add ollama --name Ollama --type ollama --base-url "http://localhost:11434/v1/"

hook add PostToolUse \
  --name "fonn-filter" \
  --matcher '^bash$' \
  --command "'/absolute/path/to/node' '/absolute/project/scripts/fonn-filter/hook.mjs' hook --provider crush --mode filter --state-dir '/absolute/project/.fonn/filtering'" \
  --timeout 5
```

If you still use the older `crush.json` format, the same hook is one entry:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^bash$",
        "command": "'/absolute/path/to/node' '/absolute/project/scripts/fonn-filter/hook.mjs' hook --provider crush --mode filter --state-dir '/absolute/project/.fonn/filtering'",
        "timeout": 5
      }
    ]
  }
}
```

Keep your other hooks. When several hooks set `updated_output`, Crush uses the last one in config order. The hook prints `{}` when it leaves output alone, and on any error, so Crush keeps the original. Crush fires `PostToolUse` for commands that exit with a failure too, because its `bash` tool reports the exit code inside the output.

## OpenCode

OpenCode loads plugins from `.opencode/plugins/` in a project or `~/.config/opencode/plugins/` for every project. `opencode-plugin.js` uses the `tool.execute.after` hook of the plugin API in OpenCode v1.19.5. For the `bash` tool it runs `hook.mjs` with `--provider opencode` and sets `output.output` to the shortened text. On any error, or after 5 seconds, it leaves the output untouched.

The simplest setup puts all the files in the plugin folder. OpenCode only loads `.js` and `.ts` files from there, so the `.mjs` modules and the license sit beside the plugin without being loaded. Download straight into it:

```sh
mkdir -p .opencode/plugins
curl -fsSL https://codeload.github.com/nord-forge/fonn/tar.gz/main \
  | tar -xz -C .opencode/plugins --strip-components=3 fonn-main/standalone/filtering
```

The plugin then finds `hook.mjs` next to itself. To keep one copy elsewhere, copy only `opencode-plugin.js` into a plugin folder and point it at the hook when you start OpenCode:

```sh
FONN_FILTER_HOOK=/absolute/project/scripts/fonn-filter/hook.mjs opencode
```

Other settings are environment variables too. `FONN_FILTER_NODE` is the Node executable (default `node` from `PATH`). `FONN_FILTER_MODE` is `filter`, `observe` or `off` (default `filter`). `FONN_FILTER_LEVEL` is `strict`, `standard` or `similar` (default `standard`). `FONN_FILTER_STATE_DIR` is the archive folder (default `.fonn/filtering` in the project). OpenCode itself runs on Bun, so Node must still be installed for the hook.

Point OpenCode at Ollama in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "qwen3.8:27b": { "name": "Qwen 3.8 27B" } }
    }
  }
}
```

The OpenCode `dev` branch has a newer plugin API built on Effect, where the same hook is `ctx.tool.hook("execute.after", ...)`. This plugin targets the released v1.19.5 API and has not been tested against the newer one.

## Recovery

A shortened output ends with a footer like the one for Claude and Codex. It holds an exact, shell-quoted `read` command with the store key and archive ID. The model can run it with the `bash` tool, and so can you:

```sh
'/absolute/path/to/node' '/absolute/project/scripts/fonn-filter/hook.mjs' read STORE_KEY ARTIFACT_ID --state-dir '/absolute/project/.fonn/filtering' --offset 0 --limit 4000
```

Each slice is JSON. Continue with `nextOffset` until it is `null`. For Crush and OpenCode the archived original is the output string, stored as JSON text. Each agent, project and session gets its own archive namespace. Retention is manual, as in the [local setup guide](local-filtering.md#modes-and-recovery).

Both agents may already shorten very long output and save the full text to a file of their own. The filter sees what the agent would send to the model.

## Claude Code with Ollama

Ollama also serves an Anthropic-compatible API, so Claude Code can run a local model. The [Claude hook](local-filtering.md#configure-claude-code) works unchanged, with `--provider claude`:

```sh
ANTHROPIC_BASE_URL=http://localhost:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" claude --model qwen3.8:27b
```

`ANTHROPIC_API_KEY=""` stops Claude Code from using a key you may have set for Anthropic. Fonn does not read or pass these values. See [Ollama's Claude Code page](https://docs.ollama.com/integrations/claude-code) for details. To use Codex with Ollama through a Fonn profile, see [Open models](open-models.md).

## Models

- **Qwen.** `qwen3.8:27b` is about 18 GB at the default quantization and has a 256K context window. Ollama can also pull a GGUF build from Hugging Face, for example `ollama pull hf.co/<user>/<repo>:Q4_K_M`.
- **Gemma.** `gemma4:26b` and `gemma4:31b` run locally with every agent here. Gemma hosted on Google's API cannot run in Codex, because that API has no Responses API and Codex needs it.
- **Kimi.** The open weights are far too large for most machines, so in practice Kimi is hosted. Ollama's `:cloud` tags, such as `kimi-k2.7-code:cloud`, run on Ollama's servers with an Ollama account. That is not local, and any billing is between you and Ollama.

Small models often struggle with tool calls and long sessions. How a model uses the recovery footer also varies. Stronger models read the original when they need a detail, and weaker ones may guess.

## Context length

Raise Ollama's context before you start an agent. Its default depends on your graphics memory and is 4,096 tokens below 24 GB, which is too small for an agent's instructions and tools. Ollama recommends at least 64k for coding agents:

```sh
OLLAMA_CONTEXT_LENGTH=65536 ollama serve
```

Check the CONTEXT column of `ollama ps` while a model is loaded. A bigger context uses more memory: a 27B model at 3 bits took about 13 GB at 32k and 19 GB at 128k in testing. Go higher only when requests fail with "exceeds the available context size". Codex needs more than most, because its first request carries every tool and integration you have set up; it came to about 72,000 tokens in testing. See [open models](open-models.md).

## Agents that cannot use the filter yet

Gemini CLI, Qwen Code, Kimi Code, Goose and Aider cannot use the filter today. Their hooks can add to a tool result or fail it, but they cannot replace the output the model sees. Appending the shortened text would make each observation longer, so Fonn does not offer a hook for them. This will change if they add a way to replace a result.
