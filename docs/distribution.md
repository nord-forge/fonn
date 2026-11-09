# CLI distribution

`nord-forge/fonn` contains the reusable core, terminal CLI, and Homebrew CLI cask in one repository. `apps/desktop` is a documentation placeholder. The root npm package coordinates workspaces and remains private; the scoped workspace names do not imply npm publication.

## Local development

Use Node 22 or later. CI checks Node 24 on Ubuntu and macOS. From the repository root:

```sh
npm ci
npm run check
node packages/cli/dist/cli/main.js --help
node packages/cli/dist/cli/main.js --cwd /absolute/path/to/project
```

The canonical entrypoint is `packages/cli/dist/cli/main.js`. The build also maintains root `dist/cli/main.js` as a local development compatibility shim. The installed command is `fonn`. With no arguments it opens ordinary interactive Claude in the current directory; leading launcher options (`--cwd`, `--profile`, `--filter`, `--state-dir`, or `--`) do the same. `fonn claude` is the explicit equivalent. SDK tasks and administration use explicit commands such as `fonn run`, `profiles`, `runs`, `show`, `output`, `native-output`, and `doctor`. `fonn --help` and `fonn --version` stay offline.

A shell alias named `fonn` can shadow the installed command. Inspect `type -a fonn`; if it is an alias, `unalias fonn` removes it from the current shell. Manually remove the alias from your shell configuration to change future shells. No installer or build edits shell configuration automatically.

## Archive preparation

From a checked-out, dependency-installed repository:

```sh
npm run check
npm run release:prepare
```

For version `0.1.0`, preparation produces:

| File | Purpose |
| --- | --- |
| `.release/fonn-0.1.0.tar.gz` | Universal JavaScript CLI payload, containing built application code, manifests, lockfile, and project license/notices. |
| `.release/SHA256SUMS` | Archive checksum for review and publication. |
| `.release/Casks/fonn.rb` | Cask generated against that exact archive and checksum. |

The same JavaScript archive supports Apple Silicon and Intel macOS through Homebrew's Node runtime. The cask requires macOS Sonoma or newer. The archive excludes `node_modules`, upstream SDK code/binaries, development dependency installations, local records/artifacts, credentials, and personal configuration. It is not a standalone bundled executable. `npm run release:check` runs the packaging tests without model requests; consult the script for the exact checks and prerequisites. Preparing an archive does not establish that a maintainer has reviewed its contents or tested Homebrew installation.

The cask depends on the Homebrew `node` formula. During installation it runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` against the shipped manifests and lockfile to obtain runtime dependencies directly on the user's machine. Installation requires registry access and can fail if downloads are unavailable. It uses the user's normal network and npm configuration files, while clearing inherited npm environment overrides and `NODE_OPTIONS`. It does not use `sudo`. The upstream SDK and its applicable runtime components are installed as dependencies under their own terms rather than redistributed inside our archive.

Ordinary Claude Code must be installed and authenticated separately for native launches. Installing Fonn does not sign in to Claude, configure API billing, supply credentials, or change global Claude settings. `fonn --help`, `--version`, `profiles`, and `doctor` stay offline; `doctor` checks API-key presence and can exit nonzero when no key is set. SDK `fonn run` can incur API charges.

## First publication and Homebrew

**Installation is unavailable until the first GitHub release archive and matching checked-in cask are published.** The public source repository alone, a locally prepared archive, or a workflow artifact does not make the cask's download URL available. No release or tag has been published as part of this preparation.

The following is a manual maintainer procedure for a future separately authorized publication. Source-repository authorization does not authorize a release or tag. Before any remote mutation, check repository policy and automation side effects. Keep version, release asset name, URL, and SHA-256 synchronized; do not publish placeholder checksums.

First run the checks, prepare the archive, and copy its generated cask into this repository:

```sh
npm run check
npm run release:prepare
mkdir -p Casks
cp .release/Casks/fonn.rb Casks/fonn.rb
```

Review the archive contents, project notices, checksum, and generated cask before committing or publishing:

```sh
tar -tzf .release/fonn-0.1.0.tar.gz
(cd .release && shasum -a 256 -c SHA256SUMS)
cat Casks/fonn.rb
git diff -- Casks/fonn.rb
```

For `0.1.0`, confirm that the cask names `fonn-0.1.0.tar.gz`, its SHA-256 matches `.release/SHA256SUMS`, and its download URL is exactly:

```text
https://github.com/nord-forge/fonn/releases/download/v0.1.0/fonn-0.1.0.tar.gz
```

Review and commit the final source and generated `Casks/fonn.rb` before creating the release tag. Once the relevant actions are authorized, a human maintainer can commit and push the cask, tag that reviewed commit, and push the tag:

```sh
git add Casks/fonn.rb
git commit -m "Add Fonn 0.1.0 Homebrew cask"
git push origin HEAD
git tag v0.1.0
git push origin v0.1.0
```

Review `docs/releases/0.1.0.md` before publication. Publish these exact archive and checksum files with those release notes:

```sh
gh release create v0.1.0 .release/fonn-0.1.0.tar.gz .release/SHA256SUMS --title 'Fonn 0.1.0' --notes-file docs/releases/0.1.0.md
```

The release page will be `https://github.com/nord-forge/fonn/releases/tag/v0.1.0`. The archive and checksum must be GitHub release assets, not only workflow artifacts. The cask remains at `Casks/fonn.rb` in the same repository; no separate Homebrew repository is needed.

Only after the release assets and matching cask are published can users run:

```sh
brew tap nord-forge/fonn https://github.com/nord-forge/fonn
brew install --cask nord-forge/fonn/fonn
fonn --version
fonn --cwd /absolute/path/to/project
```

The explicit tap URL matters: the repository is named `fonn`, without Homebrew's inferred `homebrew-` prefix. The fully qualified cask selects this repository's item. Homebrew documents these conventions in [Taps](https://docs.brew.sh/Taps) and the cask structure in the [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook).

## Workflow boundary

`ci.yml` checks pull requests and pushes with read-only repository permission, Node 24, mocked tests, and packaging validation on Ubuntu and macOS. Dependency installation can use the network; code checks do not invoke models. The manually dispatched `prepare-release.yml` checks and builds review artifacts, then uploads the archive, checksum, and generated cask as a workflow artifact. It does not publish a GitHub release or npm package, create/push a tag, change the repository cask, create a remote, or deploy. Workflow artifacts are review output, not release assets.

Publishing remains a distinct action requiring explicit authorization and a check of repository policies and automation side effects. Neither workflow has release-writing permissions or publication triggers.

## Future desktop channel

There is no `.app`, GUI cask, signing, or notarization implementation now. A future desktop host can reuse `@nord-forge/fonn-core`, but needs an actual app and a separate GUI distribution channel. The current CLI cask must not masquerade as a desktop application. See the [desktop placeholder](../apps/desktop/README.md).
