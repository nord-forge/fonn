# Authentication, estimates, and budgets

The initial supported SDK `run` path requires an explicitly supplied `ANTHROPIC_API_KEY` environment variable. This SDK path does not extract Claude subscription OAuth credentials, repurpose subscription sessions, or use subscription quotas. SDK runs use API billing separately from any Claude subscription. Keep your key in your environment or normal secret manager; do not put it in prompts, project configuration, shell history examples, or run records.

The separate `claude` launcher opens ordinary interactive Claude and inherits its normal authentication source. Billing therefore follows that CLI's active authentication, including environment API credentials when present. The launcher does not promise subscription billing, extract credentials, or impose SDK budgets/accounting on the native session. `--budget`, `--max-turns`, and `--json` are SDK `run` options and are rejected as launcher options.

`doctor` reports key presence as a boolean, never its value. It stays offline and cannot tell whether a key is valid, which models your account can access, or what your account will be charged. Normal tests mock SDK messages and never make paid API calls.

The runtime reads the SDK's cumulative estimated dollar cost and token/cache snapshots, deduplicates them, and records per-task deltas. A resume subtracts the validated same-session ancestor baseline. Counter regressions are explicitly marked indeterminate, with reported values retained as observations; they are not reported as zero-cost continuations. These amounts are development estimates, not invoices or authoritative billing data. Model pricing changes, SDK pricing tables, and billing rules can produce differences. Anthropic explicitly documents these limits in its [cost tracking guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

`--budget` is a positive dollar stop threshold; the default is $5. It is not a prepaid allowance or a guaranteed hard spending cap. An in-flight model request or tool/subagent work may push usage beyond the threshold before execution stops. `--max-turns` provides a separate positive integer limit, defaulting to 20, and is not itself a dollar cap. Cancelled and failed runs can still incur API charges. A `budget_exceeded` outcome exits nonzero and displays the estimated usage.

Start with a small task, a modest budget, and `observe` mode if you want to compare proposed output reductions before enabling them. A cheaper profile or shorter output does not guarantee a lower final bill: retries, caching, task length, and model behavior also matter. Profiles are fixed at task start and do not silently change to chase a budget.

Review actual usage and charges in your Anthropic account. Do not use these estimates for customer invoicing or other financial decisions. This fonn contains no automatic billing account setup, subscription migration, or spending-limit management.
