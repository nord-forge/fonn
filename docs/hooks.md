# Use Fonn with the tools you already have

You do not have to start your agent through Fonn to get its filter. Run `fonn hooks install` once, then keep using `claude`, `codex`, Crush, OpenCode or a desktop app built on them. Every session then gets Fonn's output filter with your global settings, your project settings and the project rules you approved.

## What it does

The hook runs after each shell command the agent runs. When the output is a format Fonn recognizes, or has long runs of repeated lines, the agent's model sees a shorter version with a footer. The footer holds a command that reads the original back. Warnings, failures, stderr and unknown output stay as they were. Everything else about the agent stays the same: its login, its permissions, its project settings and its other hooks.

The hook reads the settings of the folder the session works in, just like `fonn claude` would. That covers `filterMode`, `filterLevel`, global rules, and project rules once you approve them with `fonn config approve-rules`. With `filterMode` set to `off`, the hook does nothing for that project.

The hook fails open. If anything goes wrong, or the input is not something it knows, it prints `{}` and exits 0, so the agent keeps the original output.

## Install

```sh
fonn hooks              # what is installed, for each agent
fonn hooks install      # every agent found on this machine
fonn hooks install --agent claude --agent codex
```

A hook installed from a source checkout runs that folder's current build in every session and project, so building, switching branches or unfinished changes there affect all of them. Fonn says so when you install it and in `fonn hooks`. If you work on Fonn itself, install the hook from a second clone that stays on `main`, or from Homebrew once 0.2.0 is out.

Without `--agent`, install picks every agent whose command is on your `PATH` or whose config folder exists. For each agent it shows the file, a short summary and a diff, then asks `[y/N]`. Nothing is written until you answer yes. Outside a terminal, install refuses unless you pass `--yes`. The diff hides likely secrets: values under credential names such as `GITHUB_TOKEN`, `--api-key`, `client_secret` or `DB_PASSWORD`, everything in an `env` block, credentials inside commands such as `Authorization: Bearer ...` headers, `--token` flags, `NAME=value` assignments and passwords in URLs, and well-known token shapes such as `sk-...` or `ghp_...`. A value is the whole shell word, however deeply it is quoted. Names that only contain such a word, like `--keymap` or `--session-name`, stay visible. The file itself keeps the real values.

The first time Fonn changes a file, it keeps your original next to it as `<file>.fonn-backup`. Later changes never replace that backup. Fonn writes each file in one step, so an agent never reads half a file. If a config file is not valid, Fonn says so and changes nothing. A symlinked config, such as one kept in a dotfiles folder, is written through the link.

Only one Fonn change to a file runs at a time. A `.<file>.fonn-lock` file next to it keeps Fonn's own writers apart. Fonn never removes a lock on its own. When a lock is there, install and uninstall stop. If its process is still running and it is less than ten minutes old, Fonn says another change is in progress. Otherwise it says a lock from an earlier run that did not finish is left, and that `fonn hooks unlock` clears it.

```sh
fonn hooks unlock                 # every agent
fonn hooks unlock --agent codex
```

`fonn hooks unlock` removes a lock only when its process is gone or it is older than ten minutes. It keeps a lock that is still in use, says what it removed or kept, and never changes a config file. Just before removing a lock it checks, in one step, that the lock is still the exact file it looked at, so a lock another Fonn took meanwhile stays. Run it only when no other `fonn hooks` command is running. Node has no operating-system file lock, so two `fonn hooks unlock` commands started at the same moment as a new change could still, in theory, remove that change's fresh lock; the check right before each write still refuses to overwrite a file that changed.

Right before the new file replaces the old one, Fonn reads it again. If the content changed, or the file or its link now points somewhere else, Fonn stops and writes nothing. That last check and the replacement run back to back with no waiting in between, so another program has only a few microseconds to save the file in that gap. Editors do not take Fonn's lock, so the gap cannot be closed fully. After the change Fonn reads the file back. It also checks that the configured path still leads to the file it wrote. If a link was pointed somewhere else in that moment, Fonn reports that the config now points to another file and leaves both files alone. If another program saved it right after Fonn, that version is the newest, so Fonn keeps it rather than overwrite your work again. It reports that its own change may be missing instead of reporting success, and leaves no temporary or lock files. Run the command again to see a fresh plan. Your first original stays in `<file>.fonn-backup`.

## What changes in each file

Fonn adds one entry that runs `fonn hook --agent <agent>`. That command is how Fonn finds its own entry again. Fonn only counts an entry as its own when the whole command is exactly a Fonn command: a program named `fonn` followed by `hook --agent <agent>`, or Node with Fonn's built `packages/cli/dist/cli/main.js` (or a `dist/cli/main.js` in a package named `fonn` or `@nord-forge/fonn-cli`) followed by the same. A command split by a newline, `;`, `&` or `|` never counts. A hook that only looks similar, such as `/usr/bin/logger hook --agent claude` or a Fonn command with extra arguments, stays as it is. `fonn hooks` mentions it as a hook that looks like Fonn's but is not managed. Fonn never removes or reorders your other entries, and it never touches project or managed policy files.

| Agent | File | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR` moves it) | A `PostToolUse` group with matcher `Bash` and one command hook, timeout 5 seconds. |
| Codex | `~/.codex/hooks.json` (`CODEX_HOME` moves it) | The same shape as Claude's. |
| Crush | `~/.config/crush/crushrc` (`XDG_CONFIG_HOME` moves it) | One line at the end: `hook add PostToolUse --name fonn --matcher '^bash$' --command "..." --timeout 5`, with a comment above it. |
| OpenCode | `~/.config/opencode/plugins/fonn-hook.js` (`XDG_CONFIG_HOME` moves it) | Fonn's own plugin file. It runs the hook command for the `bash` tool, uses Node builtins only, and keeps the output after any error or 5 seconds. |

The command is absolute, so it works from desktop apps that do not have your `PATH`. A Homebrew install uses the stable link `/opt/homebrew/bin/fonn` (or `/usr/local/bin/fonn` on Intel Macs), which Homebrew moves to each new version. A source checkout uses Node and the checkout's `main.js`. Fonn prefers a stable Node link, such as Homebrew's `opt/node/bin/node`, when it points at the Node that is running.

In `crushrc`, Fonn only ever changes the exact line it wrote, with its comment above it. If the Fonn command shows up in another form, such as sharing a line with another command, inside an `if` block or a heredoc, or continued from the line above, Fonn refuses and asks you to remove it by hand. It checks the file with `bash -n`, which reads the script without running it, before and after each change. Without Bash, Fonn refuses every Crush change.

The OpenCode plugin path must be a plain file. If it is a symbolic link, install refuses, and uninstall removes the link only, never the file it points at.

Codex can also hold hooks in `[hooks]` tables in `config.toml`. Fonn only writes `hooks.json`. If you keep your hooks in `config.toml`, Codex merges both files and warns at startup. `fonn hooks` tells you when `config.toml` holds a Fonn hook, which you then remove by hand.

## Codex trust

Codex runs a user hook only after you review and trust it. After installing, open Codex and run `/hooks`, then review and trust the Fonn hook. Codex skips it until then. A changed hook needs another review, so trust it again after `fonn hooks install` updates it. Fonn never writes a trust decision.

## Check that it works

`fonn hooks` lists each agent with one of these states:

- `installed`: the entry runs this Fonn installation.
- `needs updating`: the entry points at another Fonn installation, or at a program that no longer exists. The line under it says which.
- `not installed`: the agent was found but has no Fonn entry.

It also prints a warning for each hook that is stale or broken. `fonn hooks --json` prints the same as JSON.

To see the filter at work, run a noisy command in a session, such as a test suite. The output ends with a footer like `[fonn: full original tool response archived as <artifact-id>; recover with ... native-output <id> <artifact-id> ...]`. Run that command to read the original. Sessions that `fonn claude` or `fonn codex` started already filter through their own launch hook, so the global hook leaves them alone. This only covers the same agent. Codex, Crush or OpenCode started from inside a `fonn claude` session still filter through their own global hook, and so does Claude Code inside `fonn codex`.

## Hook sessions in fonn ui

Each agent session becomes one record under `<state>/native/<id>/`, where the id comes from the agent and its session id. The record's `launch.json` says `origin: "hook"`, names the agent and has no profile. `fonn ui` lists these sessions next to native launches, with their filter decisions and the archived originals, and can delete their records. `fonn resume` does not reopen them, because Fonn did not start them.

## Saved originals and cleanup

When the hook shortens a command's output, Fonn keeps the full original so the model, or you, can read it back. With the hook installed, that happens in every session of that agent, in every project. Originals can hold private code, logs or secrets a command printed. They stay in Fonn's state folder on this machine and are never sent anywhere.

Nothing deletes them on its own. Clean up when you like:

```sh
fonn records clean --older-than 30 --dry-run   # list what would go
fonn records clean --older-than 30             # delete, after confirming
```

It removes launch and hook session records, with their originals, that were not used for that many days, and keeps anything that became active meanwhile. In `fonn ui`, the Activity page has the same cleanup with a choice of 7, 30, 90 or 180 days, and you can delete a single session from its detail page.

## Uninstall

```sh
fonn hooks uninstall
fonn hooks uninstall --agent codex
```

Uninstall shows the same kind of plan and removes only the entries that run `fonn hook --agent`. For OpenCode it removes Fonn's plugin file. Your `.fonn-backup` files stay where they are. Delete them when you no longer need them. Archived originals stay in Fonn's state folder until you remove them.

## Updating and limits

- After `brew upgrade fonn` the hook keeps working, because the command uses Homebrew's stable link.
- With a source checkout, moving the checkout breaks the hook. `fonn hooks` then reports it as broken. Run `fonn hooks install` again.
- When the Node path includes a version, as with nvm or a Homebrew Cellar folder, a Node update breaks the hook. `fonn hooks` notes this after install. Run `fonn hooks install` again after updating Node.
- A broken hook does nothing and stays quiet, because it fails open. Run `fonn hooks` now and then, or after an update.
- The filter only sees the shell tool: `Bash` in Claude Code and Codex, `bash` in Crush and OpenCode. Other tools and MCP output pass through.
- OpenCode's plugin targets the v1.19.5 plugin API. The newer API on its `dev` branch is untested.
- When several Crush hooks set `updated_output`, the last one in config order wins.
- Raw output can hold secrets. Originals are stored as private files, and retention is manual.

Sources for the config locations: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks) and [Codex config](https://learn.chatgpt.com/docs/config-file/config-advanced), [Crush hooks](https://github.com/charmbracelet/crush/tree/main/docs/hooks), and [OpenCode plugins](https://opencode.ai/docs/plugins/).
