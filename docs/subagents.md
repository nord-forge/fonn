# Native subagents

New `fonn`, `fonn claude` and `fonn codex` launches use `--subagents auto`. A SessionStart hook adds guidance to delegate meaningful independent work through the provider's built-in subagent tools. Users do not need to repeat “use subagents” in each task. The model still chooses whether and how to delegate, subject to available tools, your instructions, native settings and managed policy.

The guidance asks for at most two workers and one delegation level, read-only exploration/review, disjoint file scopes for implementation, and concise handoffs that the parent verifies. These are prompt instructions, not hard concurrency or read-only enforcement. Set stricter controls through the native provider where needed. Fonn does not replace custom agent definitions, pick worker models, force-enable disabled agents, or change provider limits.

```sh
fonn claude                         # Automatic native delegation guidance
fonn codex --subagents auto          # Same default for Codex
fonn --subagents off                 # Remove the automatic delegation preference
fonn --filter off --subagents off    # No Fonn hooks
```

`--subagents off` does not disable built-in agents or remove user instructions requesting delegation. With filtering active, workers still receive a brief filtering/recovery notice. `fonn resume` restores the saved preference. Launches saved before this setting existed resume with guidance off. SDK `fonn run` keeps its separate fixed read-only explorer/reviewer agents and enforced limits; this native flag does not apply there.

## Filtering in workers

Fonn registers its Bash PostToolUse filter for the native session. It processes supported child tool events the same way as parent events, without skipping Opus, Sonnet, Haiku or any Codex model. A SubagentStart hook reminds each worker to retain the session filter, use the recovery command when it needs full original output, and avoid further delegation or external worker processes.

Claude documents that settings-level tool hooks run inside subagents. Codex documents subagent hook events using the parent session ID. See [Claude subagent hooks](https://code.claude.com/docs/en/sub-agents#project-level-hooks-for-subagent-events) and [Codex hooks](https://learn.chatgpt.com/docs/hooks). This integration uses those native hook paths; it does not inspect or rewrite provider transcripts.

| Filter mode | Parent and supported worker Bash observations |
| --- | --- |
| `filter` | Reduce recognized noise; keep exact originals with bounded recovery. |
| `observe` | Archive proposed reductions; deliver the original unchanged. |
| `off` | No Fonn output reduction or worker filtering notice. |

Warnings, failures, stderr and arbitrary MCP payloads pass through. Unknown formats pass through apart from collapsed runs of identical lines, plus similar lines at `--filter-level similar`. `strict` turns both off. Fonn cannot filter unsupported tool paths, tools that opt out of hooks, hooks disabled by policy, or a separate CLI process started outside the native agent mechanism. Codex's new/changed hook definitions require normal manual `/hooks` review and trust; Fonn never writes trust decisions. Model choice does not affect filtering coverage. Filtering and delegation do not guarantee lower total token use.

## Permission boundaries and blocked workers

Use the provider's built-in Agent/spawn-agent tools inside the Fonn session. Fonn supplies no headless worker-launch command, and its guidance asks the agent not to start other agent CLIs on its own initiative.

### Working with another agent CLI on request

Some workflows pair agents on purpose, for example asking Claude to hand a task to Codex. When you explicitly ask for that, the guidance lets the agent run the other CLI as an ordinary shell command, such as `codex exec "<task>"`, through the normal approval prompt. That CLI keeps its own authentication, billing and policies. Fonn filters the command's final output as it returns to the calling agent, but not the other CLI's internal tool calls. `fonn codex` and `fonn claude` open interactive terminals, so they cannot be driven from another agent's tool call; use the provider's non-interactive mode instead. To give the other agent Fonn's profiles and filtering, start it yourself in its own terminal with `fonn codex` or `fonn claude`.

### Blocked workers

Native workers keep the provider's permissions and sandbox rules; foreground workers may need ordinary approval. A background or noninteractive worker that cannot obtain required approval may fail. The parent should continue authorized work itself or report the blocker, rather than change permission modes or broaden tool allowlists to retry a rejection.

Fonn rejects native `--permission-mode` and skip-permissions passthrough flags. Running `fonn -- -p ...` is not a supported route to unattended edit/shell workers. Broad rules such as `Bash(node:*)` or `Bash(rm:*)` grant open-ended execution; adding deny rules for Git or release commands does not confine those interpreters. Do not use such allowlists to work around an automatic approval rejection. Fonn's delegation guidance explicitly prohibits that retry pattern.

Existing Claude/Codex authentication, project instructions, approval prompts, hooks and managed policy remain active. For Codex, [native subagent permissions](https://learn.chatgpt.com/docs/agent-configuration/subagents#approvals-and-sandbox-controls) follow the parent session. Fonn adds no automatic approval, permission bypass, global configuration change or paid startup request.
