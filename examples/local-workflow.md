# Local workflow with temporary state

Build and inspect offline first:

```sh
npm ci
npm run check
node packages/cli/dist/cli/main.js profiles --json
node packages/cli/dist/cli/main.js doctor --json
```

To open separately installed and authenticated native Claude without an SDK run, use:

```sh
node packages/cli/dist/cli/main.js --cwd /absolute/path/to/your/project
```

After installation, the same launch is `fonn --cwd /absolute/path/to/your/project`; `fonn` alone uses the current directory. `fonn claude` is the explicit equivalent.

For an SDK task, set `ANTHROPIC_API_KEY` using your existing secure environment setup. Do not paste its value into this file. The following run makes paid API requests and may stop above its estimated budget:

```sh
fonn_state_dir="$(mktemp -d /private/tmp/fonn.XXXXXX)"
node packages/cli/dist/cli/main.js run "Inspect the test setup and report one concrete improvement. Do not edit files." \
  --cwd /absolute/path/to/your/project --profile sonnet-medium \
  --budget 1 --max-turns 8 --filter observe --state-dir "$fonn_state_dir"
node packages/cli/dist/cli/main.js runs --state-dir "$fonn_state_dir" --json
```

Use the returned IDs to inspect and continue the task. The resume command is another paid run, retains its original profile, and still requires normal permissions:

```sh
node packages/cli/dist/cli/main.js show <task-id> --state-dir "$fonn_state_dir"
node packages/cli/dist/cli/main.js output <task-id> <artifact-id> \
  --offset 0 --limit 4000 --state-dir "$fonn_state_dir"
node packages/cli/dist/cli/main.js run "Follow up on the unresolved question" \
  --cwd /absolute/path/to/your/project --resume <task-id> \
  --budget 1 --max-turns 8 --state-dir "$fonn_state_dir"
```

Artifact IDs appear in filtering decisions when an original was saved. Some runs have no artifacts. Recovery reads at most 20,000 characters per request and reports the next offset on stderr.

The temporary state directory contains sensitive run records and raw tool output. Review what you need to retain, then manually remove it when appropriate. It is not automatically cleaned up, and SDK session files may be stored separately.
