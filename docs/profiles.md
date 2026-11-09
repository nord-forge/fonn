# Profiles

A profile names a model and effort choice for native Claude launches and new SDK tasks. The built-in profiles are `opus-high`, `opus-medium`, and `sonnet-medium`. The initial default is `opus-medium`.

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
```

The last command starts an SDK task and makes paid model requests using your explicitly supplied `ANTHROPIC_API_KEY`. The native launcher uses ordinary Claude's existing authentication.

Models accept the aliases `opus`, `sonnet`, and `haiku`, or a Claude model ID such as `claude-opus-5-5`. Effort accepts `low`, `medium`, `high`, `xhigh`, and `max`. These values are checked for valid syntax; saving a profile does not verify model availability or support for its effort level.

`fonn profiles` and `fonn profiles list` show all profiles and mark the default. Their JSON output is an array of profile objects. Use `fonn profiles default --json` to read the default profile as an object. `show`, `create`, `edit`, and `default` also support `--json`; `delete --json` returns `{ "deleted": "name" }`.

Editing requires `--model`, `--effort`, or both. Built-in profiles cannot be edited or deleted. To remove a custom profile that is currently the default, select another default first:

```sh
fonn profiles default opus-medium
fonn profiles delete quick
fonn help profiles
```

Configuration lives in `~/.config/fonn/profiles.json`. Set `XDG_CONFIG_HOME` to use `$XDG_CONFIG_HOME/fonn`, or `FONN_CONFIG_DIR` to choose the Fonn configuration directory directly. This is separate from run and artifact storage selected with `--state-dir`. Profiles contain model and effort choices; keep credentials in your environment or secret manager. Profiles do not change Claude permission settings.

New launches and SDK tasks use the configured default unless `--profile` selects another profile. SDK tasks save an immutable profile snapshot: `fonn run "Continue" --resume <task-id>` uses the saved model and effort, even if the default changes or the profile is edited or deleted. Resume does not read the profile configuration. An explicit `--profile` on resume must match the saved profile name; it does not replace the saved model or effort. Start a new task to use a changed profile.

`fonn --help`, `fonn help`, `fonn help profiles`, and `fonn profiles --help` work offline and do not read profile configuration.
