# Open models

Fonn's filtering does not depend on the model. It runs in the agent's tool-output hook, before the model sees anything, so any model Codex can run gets the same reduced output, rules and recoverable originals. A Codex profile can say where its model runs with `--source`.

| Source | What it runs | What you set up |
| --- | --- | --- |
| none | OpenAI models, through your Codex sign-in | Nothing beyond Codex |
| `ollama` | A local model through `codex --oss --local-provider ollama` | Ollama, with the model pulled |
| `lmstudio` | A local model through `codex --oss --local-provider lmstudio` | LM Studio, with the model loaded |
| `provider:<name>` | A hosted model from a provider in your Codex config | A `model_providers.<name>` entry in `~/.codex/config.toml` |

With a source, the model is the name that source uses, such as `qwen3-coder:30b` in Ollama.

## Local models

Local models are free to run and the easiest way to try other models. Install [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), get a coding model, then:

```sh
ollama pull qwen3-coder:30b
fonn profiles create qwen-local --provider codex --model qwen3-coder:30b --effort medium --source ollama
fonn --profile qwen-local
```

Small models often struggle with tool calls and long sessions. That is the model, not Fonn, but it does affect how well an agent works.

## Hosted providers

Mistral, DeepSeek, Kimi, OpenRouter and other services with an OpenAI-compatible API can be added to Codex as model providers. See the Codex [CLI reference](https://learn.chatgpt.com/docs/cli/reference) for provider entries and keep the API key where Codex reads it, usually an environment variable named in the provider entry. Then point a profile at the provider by name:

```sh
fonn profiles create devstral --provider codex --model devstral-small-2 --effort medium --source provider:mistral
```

Fonn passes `-c model_provider="mistral"` and the model to Codex. It never reads, stores or passes provider keys, and it does not check that the provider exists; Codex reports a missing one at launch. Billing is between you and the provider.

To go back to OpenAI, run `fonn profiles edit <name> --source openai --model <gpt model>`.

## How well a model works with Fonn

Every model gets the same filtering. What differs is how a model reacts to it:

- **Recovery.** A shortened observation ends with a note that the original is archived and how to read it. Stronger models read it when they need a detail; weaker ones may guess instead.
- **Subagent guidance.** Some models ignore the delegation guidance Fonn adds at session start.
- **Effort.** Fonn always passes the profile's effort. Codex decides whether the model and source support it.

Model sources are new and have only been tested with mocked Codex launches so far. Results with real local and hosted models will be added here.
