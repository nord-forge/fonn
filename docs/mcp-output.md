# Collapsing MCP output in native Claude

Checked against the installed Claude Code **2.1.319**, its `--help`, and Anthropic's official documentation on 2026-11-09. No model request was made.

## Prefer the built-in collapsed view

Press **Ctrl+O** to toggle the detailed transcript viewer. The normal view shows compact tool summaries; the detailed view expands tool inputs and results, including MCP calls. In `/config`, turn **Verbose output** off. For a persistent preference, merge these keys into your existing `~/.claude/settings.json`:

```json
{
  "verbose": false,
  "viewMode": "default"
}
```

`viewMode` wins over `verbose` and a remembered `/focus` choice. Do not launch with `--verbose`: that flag overrides the setting for the session. For an even smaller transcript, `viewMode: "focus"` uses one-line tool summaries and needs the fullscreen renderer. This changes what the terminal displays; it does not remove tool results from Claude's context.

Sources: [keyboard controls](https://code.claude.com/docs/en/interactive-mode#general-controls), [verbose](https://code.claude.com/docs/en/settings-reference#verbose), [viewMode](https://code.claude.com/docs/en/settings-reference#viewmode).

## Display size and model context are separate

A result returned by an MCP server becomes model input when it is included in the next request. It is not model-generated output merely because the terminal calls it tool output. Hiding or expanding the display does not change that request. A footer token count alone cannot establish the size or cost of one MCP result. Native Claude's active authentication and service accounting still apply; Fonn character reductions are not measured token or billing savings.

Source: [Anthropic's tool-use request flow and pricing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing).

Claude already stores sufficiently large successful text results in the session's `tool-results` directory and supplies a file reference. The documented defaults are 25,000 tokens and, for foreground text results without a declared tool limit, 50,000 characters. `MAX_MCP_OUTPUT_TOKENS` changes the token threshold, not the fixed character threshold. Text tools declaring `_meta["anthropic/maxResultSizeChars"]` use their own limit instead of that environment variable. Reading the saved content later brings those portions into context. These limits are not an expand/collapse control.

Source: [MCP output limits and warnings](https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings).

## Current Fonn behavior

`fonn` (or the explicit `fonn claude`) sets `verbose: false` and `viewMode: "default"` in its private per-launch settings, including when filtering is off. Global Claude settings are unchanged. Press Ctrl+O to expand details, or pass `-- --verbose` to request the verbose view for one launch. The current native `PostToolUse` hook matches only `Bash`, and its handler rejects other tool names. SDK mode receives all successful tool observations, but the shared filter recognizes shell-output formats and leaves MCP content-block objects unchanged. Consequently, the current filter does not shorten arbitrary issue descriptions returned by an MCP server.

Relevant implementation: `packages/cli/src/native/index.ts`, `packages/core/src/runtime/options.ts`, and `packages/core/src/filtering/index.ts`.

For a separate, optional context-size limit, try a lower native offload threshold for a single launch:

```sh
MAX_MCP_OUTPUT_TOKENS=6000 fonn --cwd /absolute/path/to/project
```

This asks Claude to use a file reference sooner for eligible large MCP results; it is not a hard token budget. Tool-declared character limits can take precedence, and Claude may read the saved content later. It does not retroactively shrink earlier messages. No generic MCP truncation is applied by Fonn.

If model-input reduction is requested separately, prefer narrower server queries, pagination, or requested fields. An additional filter would need an explicit, tool-specific recognized schema; preserve warnings, failures, unknown fields and content blocks; archive the full original; and provide bounded recovery. Do not truncate all MCP content by default: issue descriptions and logs may contain evidence the model needs.

The supported hook mechanism is synchronous `PostToolUse` with `hookSpecificOutput.updatedToolOutput`; the replacement must preserve the tool output's shape. `updatedMCPToolOutput` is the older MCP-only field. `additionalContext` appends text, and `decision: "block"` leaves the original output visible to Claude, so neither is an output-saving replacement. A hook cannot undo a tool's completed side effects, and telemetry may retain the original result.

Source: [PostToolUse decision control](https://code.claude.com/docs/en/hooks#posttooluse-decision-control). The installed Agent SDK 0.3.319 types also expose `updatedToolOutput`.
