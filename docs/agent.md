# Fonn agent

`fonn chat` is a small coding agent for open models. It talks to Ollama, LM Studio or any server with an OpenAI-compatible chat API, runs commands and edits files in your project, and filters command output before the model sees it. You do not need Claude Code or Codex.

```sh
fonn chat --model qwen3.8:27b                 # Ollama on this machine
fonn chat --model gemma4:26b --source lmstudio
fonn chat --profile qwen-local                 # a Codex profile with an ollama or lmstudio source
fonn chat --model kimi-k3 --base-url https://api.moonshot.ai/v1 --api-key-env MOONSHOT_API_KEY
```

## Why a separate agent

General agents send a large first request: their instructions plus every tool and integration they know. In testing, Codex's first request came to about 72,000 tokens, and a 27B local model needed about half an hour to read it before answering. Fonn's agent sends a short system prompt and six tools, under 1,000 tokens in all, so a local model starts answering quickly.

In testing with Qwen3.8-27B (UD-IQ3_XXS) on Ollama, the same task, listing a folder and counting its files, used about 950 tokens of context with `fonn chat` against about 73,000 with Codex. A noisy command that printed 400 nearly identical lines reached the model as 357 characters instead of 25,892, and the model still described it correctly.

## Tools

| Tool | What it does | Asks first |
| --- | --- | --- |
| `run_command` | Runs a shell command in the project root, with a time limit | Always |
| `read_file` | Reads part of a file | Outside the project, for secret files, and always with a server elsewhere |
| `list_files` | Lists a folder | Outside the project, and always with a server elsewhere |
| `write_file` | Creates or replaces a file | Always |
| `edit_file` | Replaces one exact piece of text in a file | Always |
| `read_original` | Reads an archived original of shortened command output | Never |

When Fonn asks, you can allow once, allow that exact command or file for the rest of the session, or say no and tell the model why. Nothing can turn the questions off.

## Filtering

Command output goes through the same filter as Fonn's Claude and Codex launches, with the project's settings, level and approved rules. A shortened output ends with a note, and the model can read the full original with `read_original`. Originals stay in Fonn's state folder for this session.

## Context

Local models have small context windows. Fonn keeps a rough token count and, when the conversation gets close to the limit, shortens the oldest command output first. Set the limit with `--context <tokens>` to match the context your server uses, such as Ollama's `OLLAMA_CONTEXT_LENGTH`.

## Privacy

Prompts, file contents and command output go to the server you chose. For Ollama and LM Studio on this machine, nothing leaves it. A server elsewhere, such as a hosted API through `--base-url`, receives everything the model reads. So Fonn decides from the server address:

- **On this machine** (`localhost`, `127.0.0.1` or `::1`): reads inside the project need no approval, except files that usually hold secrets.
- **Anywhere else**: every read and folder listing asks first, and the header says so. "Always" covers that exact file for the rest of the session.
- **Secret files ask on any server**: `.env` and its variants (but not `.env.example` or similar templates), private keys such as `*.pem`, `*.key` and `id_ed25519`, `.npmrc`, `.netrc`, `.git-credentials`, credential and secret files, and anything in folders such as `.ssh`, `.aws` or `.gnupg`.

Commands always ask too, so a command that prints a secret, such as `cat .env`, also needs your approval. Fonn reads an API key only from the environment variable you name with `--api-key-env`. It is never written to disk or shown.
