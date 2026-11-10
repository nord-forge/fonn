# Filtering and recovery

The default `filter` mode conservatively shortens recognized noisy tool observations. `observe` computes and records proposed reductions but delivers the original. `off` delivers original observations without reduction. These modes are selected per run with `--filter`.

The adapters recognize direct Pest/PHPUnit, TypeScript `tsc`, PHPStan, pytest, Jest and Vitest output:

| Adapter | Commands | Removes |
| --- | --- | --- |
| PHPUnit, Pest | `phpunit`, `pest`, `php artisan test` | Progress rows made only of dots and a counter |
| PHPStan | `phpstan analyse` | Progress bar rows, once an `[OK]` or `[ERROR]` verdict is present |
| `tsc` | `tsc`, `npx tsc` | Adjacent byte-identical diagnostics, kept once with a count |
| pytest | `pytest`, `py.test`, `python -m pytest`, `.venv/bin/pytest` | Rows made only of dots and a `[ NN%]` counter, and `-v` lines ending in `PASSED [ NN%]` |
| Jest | `jest`, `npx jest` | `PASS <file>` lines and `✓` passing-test lines |
| Vitest | `vitest`, `npx vitest run` | `✓` file and test lines |

`npm test`, `npm run test`, `pnpm test` and `yarn test` try the Jest and Vitest adapters, because that is how those runners are usually started. Each adapter needs the runner's own summary first: pytest's `test session starts` header and final `in N.NNs` line, Jest's `Test Suites:` and `Tests:` totals, or Vitest's `Test Files` and `Tests` counts. Rows with `F`, `E`, `s` or `x`, and lines marked `FAILED`, `SKIPPED`, `✕`, `×`, `○` or `↓`, always stay, as do warnings, console output and the summary. Coloured output is refused, so run these tools without forced colour (most disable colour when the output is not a terminal). Jest writes its whole report to stderr; it is filtered because both agents merge the streams. Vitest 5 prints only failures and totals when piped, so the Vitest adapter mainly helps with `--reporter verbose` and older versions that list passing files.

Docker, wrapper commands and other unknown tools skip the adapters, as do ANSI cursor-control output and unknown formats. An adapter must recognize the output format and establish a useful reduction before changing an observation. Warnings, failures, stderr, and ambiguous output are preserved rather than summarized away. The exact supported command/output patterns are defined by the filter adapters and their fixtures; a familiar command name alone is not permission to discard arbitrary text.

## Filter levels

`--filter` decides whether Fonn acts (`filter`), only records (`observe`) or does nothing (`off`). `--filter-level` decides how far it goes.

| Level | Reduces |
| --- | --- |
| `strict` | Format adapters only: PHPUnit, Pest, PHPStan, `tsc`, pytest, Jest and Vitest, from a single direct command. |
| `standard` (default) | Adds identical lines for any command. Three or more byte-identical, non-blank adjacent lines keep one copy and an exact count. |
| `similar` | Adds similar lines. Four or more adjacent lines that match once numbers, UUIDs and long hex IDs are masked keep their first and last line, with a count between them. |

The generic reductions run only when no format adapter applies, including for pipelines and unknown tools. An identical-line run is marked `[fonn: identical line occurred N times; N-1 duplicate copies archived]`. A similar-line run is marked `[fonn: similar lines omitted; N lines between these differ only in numbers or IDs; originals archived]`.

At the `similar` level, `PROGRESS worker=0 status=healthy` and `PROGRESS worker=3 status=healthy` collapse together. `status=unhealthy` does not, because a word changed. Lines that mention errors, failures, warnings, exceptions, panics or denials are never merged by similarity. Lines without words, such as rows of numbers, are left alone. Use `similar` only when the exact numbers in repeated log lines do not matter to the task. Originals stay recoverable at every level.

```sh
fonn --default-filter-level similar   # save a default level
fonn --default-filter-level           # show it
fonn --filter-level strict            # override it for one launch
fonn codex --filter-level similar --filter observe
fonn run "Explain the failing job" --filter-level similar
```

The saved level lives in `profiles.json` in the Fonn configuration directory. A native launch records its level and `fonn resume` restores it. A resumed SDK task keeps its saved level unless `--filter-level` is given. Sessions and tasks saved before levels existed resume as `strict`, which is how they ran. `--filter-level` with `--filter off` is rejected. The standalone hook takes `--level strict|standard|similar` and defaults to `standard`. Every level keeps the 2,000-character minimum, the 256-character minimum saving, and the refusal of terminal colour codes and carriage returns. Claude Code and Codex both hand the hook a command's stdout and stderr merged into one stream, so that combined text is what gets filtered. Adapters never remove failure, warning or error lines from it, and repeated stderr lines are only collapsed with an exact count. Claude Code's separate `stderr` field holds the tool's own notices and is never changed.

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
