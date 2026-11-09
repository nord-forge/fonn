# Future desktop application

This directory reserves a future GUI in the Fonn monorepo. It will consume `@nord-forge/fonn-core`; CLI code and a future desktop host should share contracts and behavior through that package.

There is no desktop implementation, `.app` bundle, installer, signing, or notarization pipeline here. No GUI launch or installation command is available. The prepared Homebrew cask targets the CLI only; installation requires a published release archive and matching repository cask.

A future desktop release requires an actual application, platform integration, signing and notarization decisions, and a separate GUI cask/channel. That work must preserve core authentication, permissions, output recovery, and estimated-accounting boundaries. See [architecture](../../docs/architecture.md) and [distribution](../../docs/distribution.md).
