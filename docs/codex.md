# Native Codex

Fonn opens the separately installed Codex CLI with a saved model and effort profile. Codex keeps its authentication, interactive terminal controls, project settings, permissions and sandbox policy. Use Codex CLI 0.167.0 or newer. Install and authenticate Codex first; see the official [CLI reference](https://learn.chatgpt.com/docs/cli/reference) and [authentication guide](https://learn.chatgpt.com/docs/auth). ChatGPT sign-in and API-key sign-in use their respective access and billing arrangements; Fonn does not extract credentials or promise subscription coverage.

```sh
fonn codex
fonn codex --cwd /absolute/path/to/project --profile codex:sol-medium
fonn profiles create my-sol --provider codex --model gpt-6.1-sol --effort high
fonn --profile my-sol
fonn codex --filter observe
fonn codex --filter off -- --search
```

`fonn codex` uses the configured default if it is a Codex profile, otherwise the built-in `codex:sol-medium`. An explicit `--profile` must name a Codex profile. With no command, Fonn follows the selected or default profile's provider. Fonn profiles are separate from Codex's own configuration profiles; see [profiles](profiles.md).

Pass supported interactive Codex arguments after `--`: one quoted prompt, help/version, `--no-alt-screen`, `--no-daemon`, `--strict-config`, `--search`, and `--image`/`-i` with a path. Resume/fork and management commands currently require plain Codex. Fonn rejects arguments that override its chosen model, effort, hook configuration or permission policy. Use plain `codex` for management, cloud or noninteractive commands. Fonn does not add approval bypasses, automatically approve tools, or change your global Codex settings.

## Review and trust the output hook

The default `--filter filter` requires a Codex version with lifecycle hook support. Fonn supplies a stable hook command for the launch. Open `/hooks` in Codex, inspect the Fonn hook and explicitly trust it. Codex skips new or changed non-managed hook definitions until reviewed; a Fonn update may require another review. Fonn does not use a hook-trust bypass or write trust decisions. See the official [hooks documentation](https://learn.chatgpt.com/docs/hooks).

Until the hook is trusted, Fonn output filtering is inactive. Codex's own project trust and managed requirements still apply. Keep your existing security decisions in place.

`filter` replaces only recognized noisy shell output represented as text or a stdout record; Codex metadata wrappers and other response shapes can remain unchanged. It preserves warnings, errors and unknown formats. `observe` archives proposed reductions while leaving the delivered tool output unchanged. `off` registers no Fonn hook. The Codex hook uses its supported post-tool feedback contract to deliver a reduced observation; it does not undo a completed tool call or modify source files, instructions or prior history. Output visibility in the terminal alone does not demonstrate fewer model-input tokens.

## Recover original output

Fonn records a launch ID and keeps recoverable originals in its native launch store. Use the ID and artifact hint shown for a filtered observation:

```sh
fonn native-output <launch-id> <artifact-id>
fonn native-output <launch-id> <artifact-id> --offset 4000 --limit 4000
```

Use the same `--state-dir` if the launch selected one. Reads remain bounded and confined to the launch's artifact store. Prompts, paths and tool output may be sensitive; retention is manual.

Native Codex sessions have no Fonn SDK budgets, structured task results or usage accounting. `fonn run` remains Claude SDK only, and `fonn run --resume` resumes saved Claude SDK tasks. A programmatic Codex SDK runtime is not implemented.

The adapter is verified with offline fixtures and Codex’s documented hook contract. Live hook delivery, account-specific model access and real token savings have not been measured. A real help/configuration smoke check does not establish live model behavior.
