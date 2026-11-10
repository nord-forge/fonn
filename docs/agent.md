# Fonn agent

`fonn chat` is a small coding agent for open models. It talks to Ollama, LM Studio or any server with an OpenAI-compatible chat API, runs commands and edits files in your project, and filters command output before the model sees it. You do not need Claude Code or Codex.

```sh
fonn chat --model qwen3.8:27b                 # Ollama on this machine
fonn chat --model gemma4:26b --source lmstudio
fonn chat --profile qwen-local                 # a Codex profile with an ollama or lmstudio source
fonn chat --model kimi-k3 --base-url https://api.moonshot.ai/v1 --api-key-env MOONSHOT_API_KEY
```

## Why a separate agent

General agents send a large first request: their instructions plus every tool and integration they know. In testing, Codex's first request came to about 72,000 tokens, and a 27B local model needed about half an hour to read it before answering. Fonn's agent sends a short system prompt and six tools, a few thousand tokens in all, so a local model starts answering quickly.

## Tools

| Tool | What it does | Asks first |
| --- | --- | --- |
| `run_command` | Runs a shell command in the project root, with a time limit | Always |
| `read_file` | Reads part of a file | Only outside the project |
| `list_files` | Lists a folder | Only outside the project |
| `write_file` | Creates or replaces a file | Always |
| `edit_file` | Replaces one exact piece of text in a file | Always |
| `read_original` | Reads an archived original of shortened command output | Never |

When Fonn asks, you can allow once, allow that exact command or file for the rest of the session, or say no and tell the model why. Nothing can turn the questions off.

## Filtering

Command output goes through the same filter as Fonn's Claude and Codex launches, with the project's settings, level and approved rules. A shortened output ends with a note, and the model can read the full original with `read_original`. Originals stay in Fonn's state folder for this session.

## Context

Local models have small context windows. Fonn keeps a rough token count and, when the conversation gets close to the limit, shortens the oldest command output first. Set the limit with `--context <tokens>` to match the context your server uses, such as Ollama's `OLLAMA_CONTEXT_LENGTH`.

## Privacy

Fonn reads an API key only from the environment variable you name with `--api-key-env`. It is never written to disk or shown. Prompts, file contents and command output go to the server you chose. For Ollama and LM Studio that is your own machine.
