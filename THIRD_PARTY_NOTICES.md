# Third-party notices

Fonn's own code is covered by the root [MIT license](LICENSE). That license does not relicense its dependencies, Claude Code, or Anthropic/OpenAI services. This is an independent project and does not imply Anthropic or OpenAI endorsement.

## Claude Agent SDK and Claude Code

The pinned `@anthropic-ai/claude-agent-sdk` dependency is maintained by Anthropic. The installed `0.3.321` package declares `SEE LICENSE IN README.md`; its included license notice states that Anthropic retains its rights and refers users to [Anthropic's legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance). Those terms apply independently of this project's MIT license. Refer to the installed dependency's own license/readme and current applicable agreements for the complete terms.

Our release archive does not include `node_modules`, the SDK, or Claude Code binaries. The CLI cask fetches locked runtime dependencies through `npm ci --omit=dev --ignore-scripts` on the end user's machine. Those dependencies retain their own terms and are not bundled into our release archive. Native launches use the user's separately installed, unmodified Claude Code and its normal authentication. SDK tasks require the user's own explicit API key and incur separate API billing; the project does not collect subscription credentials or supply Anthropic service access. See [billing](docs/billing.md).

## Codex CLI

Native Codex launches use the user’s separately installed, unmodified Codex CLI and its existing authentication. Fonn does not bundle Codex binaries or the Codex SDK in its archive. Codex and OpenAI services retain their own applicable licenses and terms.

## Zod

The pinned `zod` dependency is MIT licensed. Its installed license carries the following notice:

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other installed dependencies

The lockfile records the exact dependency graph. Transitive runtime packages, optional platform packages, and development tools retain their own licenses and notices in their installed package distributions. Their presence does not expand this project's MIT grant. Release preparation excludes installed dependency directories; do not add vendored dependencies or binaries without reviewing and retaining their applicable notices and terms.
