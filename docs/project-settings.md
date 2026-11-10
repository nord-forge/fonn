# Project settings

Fonn can keep defaults per project, so a repository can always start with the right agent, profile and filtering, without typing flags.

## Files

| File | Scope | In Git |
| --- | --- | --- |
| `.fonn.json` at the project root | Shared with everyone working on the project | Commit it |
| `.fonn/settings.local.json` | Personal | Keep it out of Git; `.fonn/` is usually ignored already |

The project is the nearest folder, from where you run Fonn upwards, that has one of these files. Without either file, it is the Git root.

## Keys

| Key | Values | Meaning |
| --- | --- | --- |
| `profile` | A built-in or custom profile name | The profile to launch with. A Codex profile makes plain `fonn` open Codex |
| `filterLevel` | `strict`, `standard`, `similar` | How far filtering goes; see [filter levels](filtering.md#filter-levels) |
| `filterMode` | `filter`, `observe`, `off` | Whether filtering acts, only records, or is off |
| `subagents` | `auto`, `off` | Native subagent guidance |

Anything else is rejected, including unknown keys, so a typo never goes unnoticed. Paths, commands and credentials can never be set in these files.

```json
{
  "profile": "sonnet-medium",
  "filterLevel": "similar"
}
```

## Precedence

```
command-line flag > .fonn/settings.local.json > .fonn.json > global default > built-in default
```

Global defaults stay where they were: `fonn --default`, `fonn --default-filter-level` and `fonn profiles default`.

When a launch or run uses a value from a project file, Fonn prints it, for example `Project settings: filterLevel similar (.fonn.json).` A shared file comes from whoever wrote the repository and can choose a different model, so check that line when you start working in an unfamiliar project.

For an explicit `fonn claude` or `fonn codex`, a project profile for the other agent is ignored with a note, and that agent's default profile is used. A `--profile` flag for the wrong agent is still an error. Resuming an SDK task with `fonn run --resume` reads no settings files; the task keeps its saved profile and level.

## The fonn config command

```sh
fonn config                              # effective settings and where each comes from
fonn config get filterLevel
fonn config set filterLevel similar      # personal, in .fonn/settings.local.json
fonn config set profile sonnet-medium --shared   # team, in .fonn.json
fonn config unset filterLevel --shared
```

`--cwd <dir>` works on every subcommand. Setting a personal value warns when `.fonn/` is not ignored by Git, and setting a custom profile in the shared file reminds you that teammates need a profile with the same name.
