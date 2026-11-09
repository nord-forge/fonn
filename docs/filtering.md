# Filtering and recovery

The default `filter` mode conservatively shortens recognized noisy tool observations. `observe` computes and records proposed reductions but delivers the original. `off` delivers original observations without reduction. These modes are selected per run with `--filter`.

The initial adapters recognize direct Pest/PHPUnit, TypeScript `tsc`, and PHPStan output. Docker, npm, and other wrapper commands intentionally pass through, as do ANSI cursor-control output and unknown formats. An adapter must recognize the output format and establish a useful reduction before changing an observation. Warnings, failures, stderr, and ambiguous output are preserved rather than summarized away. The exact supported command/output patterns are defined by the filter adapters and their fixtures; a familiar command name alone is not permission to discard arbitrary text.

Filtering touches only the newly received tool observation. It never rewrites prior conversation history, source files, user or policy instructions, reasoning blocks, or arbitrary context. Filtered observations point to preserved originals. If recovery storage fails, the original output must remain available to the model rather than being discarded.

Each decision records the adapter, mode, reason, original/proposed/delivered character counts, removed lines, and artifact ID where applicable. Observe-mode proposals are not realized savings. A character count is not a token count or an API-cost measurement. Benchmarks motivated this approach but do not establish 60% savings or quality guarantees for your tasks.

Recover the original in slices:

```sh
fonn show <task-id> --json
fonn output <task-id> <artifact-id> --offset 0 --limit 4000
fonn output <task-id> <artifact-id> --offset 4000 --limit 4000
```

Use the actual next offset printed on stderr rather than assuming a fixed slice size. The limit defaults to 4,000 characters and must be a positive integer no larger than 20,000; the offset is a nonnegative integer. With a custom state directory, pass the same `--state-dir` to show/output. Artifacts cannot be read across task stores or through arbitrary paths. Terminal control characters are escaped when displayed; originals in storage are unchanged.

On SDK resume, the model's recovery tool may also resolve artifacts from the validated ancestor chain of that same session and project. It cannot reach unrelated tasks. For CLI recovery, supply the task ID that originally stored the artifact.

Interactive `claude` launches use the same filter through a generated PostToolUse hook for Bash responses. Their artifacts live under a separate native launch store. A reduced observation includes a recovery command using `native-output <launch-id> <artifact-id>`. This path inherits ordinary Claude authentication and permission handling; it does not create SDK run records or impose SDK budgets.

State contains raw tool responses and can include secrets or private project data. Choose a state location appropriate to the project, protect it like source and logs, and manage retention manually. The fonn does not automatically erase raw output or claim that filtering redacts secrets.

The SDK hook mechanism is described in Anthropic's [hooks documentation](https://code.claude.com/docs/en/agent-sdk/hooks).
