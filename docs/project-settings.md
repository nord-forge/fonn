# Project settings

Fonn keeps settings at three levels: for all your projects, for one repository shared with your team, and for one repository just for you. A repository can then always start with the right agent, profile and filtering, without typing flags.

## Files

| File | Scope | In Git |
| --- | --- | --- |
| `~/.config/fonn/profiles.json` | Global: all your projects | Not in a repository |
| `.fonn.json` at the project root | Shared with everyone working on the project | Commit it |
| `.fonn/settings.local.json` | Personal, for this project | Keep it out of Git; `.fonn/` is usually ignored already |

The project is the nearest folder, from where you run Fonn upwards, that has one of these files. Without either file, it is the Git root.

## Keys

| Key | Values | Meaning |
| --- | --- | --- |
| `profile` | A built-in or custom profile name | The profile to launch with. A Codex profile makes plain `fonn` open Codex |
| `filterLevel` | `strict`, `standard`, `similar` | How far filtering goes; see [filter levels](filtering.md#filter-levels) |
| `filterMode` | `filter`, `observe`, `off` | Whether filtering acts, only records, or is off |
| `subagents` | `auto`, `off` | Native subagent guidance |

Each file can also hold `rules`, a list of filter rules. They only apply after you approve them with `fonn config approve-rules`; see [your own rules](filtering.md#your-own-rules). Anything else is rejected, including unknown keys, so a typo never goes unnoticed. Paths, commands and credentials can never be set in these files.

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

Global values are set with `fonn config set <key> <value> --global`. `fonn --default`, `fonn --default-filter-level` and `fonn profiles default` remain shortcuts for them. A value only counts as a global default once you have saved one; otherwise the built-in default applies, and `fonn config` labels it that way.

When a launch or run uses a value from a project file, Fonn prints it, for example `Project settings: filterLevel similar (.fonn.json).` A shared file comes from whoever wrote the repository and can choose a different model, so check that line when you start working in an unfamiliar project.

For an explicit `fonn claude` or `fonn codex`, a project profile for the other agent is ignored with a note, and that agent's default profile is used. A `--profile` flag for the wrong agent is still an error. Resuming an SDK task with `fonn run --resume` reads no settings files; the task keeps its saved profile and level.

## The fonn config command

```sh
fonn config                              # effective settings and where each comes from
fonn config get filterLevel
fonn config set filterLevel similar      # personal, in .fonn/settings.local.json
fonn config set profile sonnet-medium --shared   # team, in .fonn.json
fonn config set filterMode observe --global      # all projects
fonn config unset filterLevel --shared
fonn config unset filterMode --global
```

`--cwd <dir>` works on every subcommand. Setting a personal value warns when `.fonn/` is not ignored by Git, and setting a custom profile in the shared file reminds you that teammates need a profile with the same name.
