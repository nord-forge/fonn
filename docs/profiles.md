# Profiles

A profile names a provider, model and effort choice. The Claude built-ins are `opus-high`, `opus-medium`, `sonnet-medium`, `claude:fable-medium` and `claude:mythos-medium`; the Codex built-in is `codex:sol-medium` (`gpt-6.1-sol`, medium effort). The initial default is `opus-medium`. Profiles without a provider field remain Claude profiles.

```sh
fonn profiles
fonn profiles list --json
fonn profiles show opus-medium
fonn profiles create quick --model haiku --effort low
fonn profiles edit quick --model sonnet --effort high
fonn profiles default quick
fonn profiles default
fonn --profile quick
fonn run "Explain this project" --profile quick
fonn profiles create my-sol --provider codex --model gpt-6.1-sol --effort high
fonn codex --profile my-sol
```

`fonn run` starts a Claude SDK task and makes paid model requests using your explicitly supplied `ANTHROPIC_API_KEY`. Native launchers use their respective CLI's existing authentication. Programmatic Codex SDK tasks are not implemented.

`--provider` accepts `claude` or `codex` and defaults to Claude when creating a profile. Claude models accept `opus`, `sonnet`, `haiku`, `fable`, `mythos`, or a Claude model ID such as `claude-opus-5-5`. Codex models accept `gpt-*` and o-series IDs, such as `gpt-6.1-sol`. Provider/model pairs are validated for syntax. Effort accepts `low`, `medium`, `high`, `xhigh`, and `max`; saving a profile does not verify model availability or support for its effort level.

`fonn profiles` and `fonn profiles list` show each provider and mark the default. Their JSON output remains an array of profile objects; Codex profiles include `"provider": "codex"`, while existing Claude objects can omit `provider`. Use `fonn profiles default --json` to read the default profile as an object. `show`, `create`, `edit`, and `default` also support `--json`; `delete --json` returns `{ "deleted": "name" }`.

Editing requires `--provider`, `--model`, `--effort`, or a combination. Changing providers may require a compatible model in the same edit. Built-in profiles cannot be edited or deleted. To remove a custom profile that is currently the default, select another default first:

```sh
fonn profiles default opus-medium
fonn profiles delete quick
fonn help profiles
```

Use `fonn --default codex` or `fonn --default claude` to select the default coding agent without launching it. `fonn --default` shows the current agent and profile; add `--json` for `{ "provider": "codex", "profile": "codex:sol-medium" }`. If the current default profile already belongs to the requested agent it is preserved; switching agents selects that provider's built-in default. This updates the same default profile as `fonn profiles default`, so the two commands stay in sync. Explicit agent commands and `--profile` still take precedence for a single launch without changing the saved default.

Configuration lives in `~/.config/fonn/profiles.json`. Set `XDG_CONFIG_HOME` to use `$XDG_CONFIG_HOME/fonn`, or `FONN_CONFIG_DIR` to choose the Fonn configuration directory directly. This is separate from run and artifact storage selected with `--state-dir`. Profiles contain provider, model and effort choices; keep credentials in your environment or secret manager. Profiles do not change permission settings.

`fonn` with no command follows the selected profile's provider: a Codex default opens Codex, and a Claude default opens Claude. `fonn --profile my-sol` opens Codex directly. Explicit `fonn claude` and `fonn codex` use the global default when it belongs to that provider, otherwise `opus-medium` or `codex:sol-medium` respectively. An explicit `--profile` must match the requested provider.

New SDK tasks use the configured default unless `--profile` selects another profile, and reject Codex profiles with guidance to use the native launcher. SDK tasks save an immutable profile snapshot: `fonn run "Continue" --resume <task-id>` uses the saved model and effort, even if the default changes or the profile is edited or deleted. Resume does not read the profile configuration. An explicit `--profile` on resume must match the saved profile name; it does not replace the saved model or effort. Start a new task to use a changed profile.

`fonn --help`, `fonn help`, `fonn help profiles`, `fonn profiles --help`, `fonn help codex`, and `fonn codex --help` work offline and do not read profile configuration. See [native Codex](codex.md) for hooks, trust and output recovery.

Custom names use lowercase letters, digits and hyphens. New Claude and Codex built-ins use the reserved `claude:` and `codex:` namespaces so they cannot collide with previously saved custom profile names.


## Fable and Mythos

| Built-in profile | Saved model | Effort |
| --- | --- | --- |
| `claude:fable-medium` | `claude-fable-5-2` | `medium` |
| `claude:mythos-medium` | `claude-mythos-5-2` | `medium` |

Fonn's short names `fable` and `mythos` normalize to these exact 5.2 IDs before a profile is persisted, launched or resumed. They do not follow Claude Code's rolling `fable` alias or its environment override. Existing aliases (`opus`, `sonnet`, `haiku`) retain their behavior. Full Claude model IDs remain accepted for other versions.

```sh
fonn --profile claude:fable-medium
fonn --profile claude:mythos-medium
fonn profiles create mythos-high --model mythos --effort high
fonn profiles default mythos-high
fonn profiles show mythos-high --json
```

The native launcher requires Claude Code 2.1.321+ for these 5.2 models and rejects older versions before creating launch state. The SDK runtime uses pinned Agent SDK 0.3.321. Other model launches retain Fonn's existing 2.1.319 native baseline. Install/authenticate the provider separately; creating a profile and listing presets remain offline and do not verify account entitlement. Mythos is available only to eligible verified accounts. Upstream errors and access requirements remain authoritative; Fonn adds no fallback, permission change or automatic paid request.

Filtering processes supported new tool observations for these models and their native workers using the same hooks as other Claude models. Fonn does not edit prior messages or reasoning blocks. SDK tasks can select either main model while retaining the existing fixed read-only explorer/reviewer models and limits. Saved snapshots keep their model/effort across profile changes. Selecting a new profile does not change the default unless you explicitly save it.

Sources: [Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview), [Mythos 5.2](https://platform.claude.com/docs/en/models/mythos-5-2/overview), [Claude Code requirements and aliases](https://code.claude.com/docs/en/model-config), and the [migration guide](https://platform.claude.com/docs/en/models/fable-5-2/migration-guide). Availability and costs depend on the provider/account; native and SDK billing paths remain separate.
