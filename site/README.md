# Fonn docs site

The documentation site, built with [Astro Starlight](https://starlight.astro.build/). It has a landing page with a WebGL hero, the docs pages, the guides from `../docs` under *Reference*, and an interactive filter visualiser at `/how-it-works/`.

This is a separate npm project with its own `package-lock.json`. Keep it out of the root workspaces: the Homebrew cask runs `npm ci --omit=dev` against the root lockfile on users' machines, and the site's dependencies must never reach that install.

## Preview locally

From the repository root:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix site
npm run docs:dev
```

`docs:dev` compiles the core, then starts Astro's dev server at http://127.0.0.1:4321/. `npm run docs:build` writes the static site to `site/dist`. `npm run build` at the root stays focused on the CLI and core.

## How the build works

`npm run build` in `site/` runs three steps:

1. **`scripts/prepare-content.mjs`** copies the guides from `../docs` into `src/content/docs/reference/`, which is generated and ignored by Git. Links between guides become site links, and links to other repository files point at GitHub. The script also runs every visualiser sample through the compiled filter at each level, and fails when a result no longer matches.
2. **`astro build`** renders the pages. The profile table and the before and after demos are generated from the compiled core at build time. The visualiser bundles the real compiled filter; `astro.config.mjs` swaps its file-backed archive module for a browser stub.
3. **`scripts/check-links.mjs`** fails the build if any internal link or `#anchor` in the output points nowhere.

Sample character counts describe those samples only. They are not token, cost or accuracy benchmarks.

## Layout

| Path | Purpose |
| --- | --- |
| `astro.config.mjs` | Starlight settings: sidebar, theme CSS, component overrides |
| `src/content/docs/` | The pages, as Markdown and MDX. `reference/` is generated |
| `src/pages/how-it-works.astro` | The interactive visualiser page |
| `src/components/` | Starlight overrides (`Hero`, `Head`, the header star link, the empty mobile controls) and build-time components (`ProfilesTable`, `FilterDemo`) |
| `src/scripts/dock.js` | The mobile section dock, which replaces Starlight's mobile menu and "On this page" bar |
| `src/scripts/hero/` | WebGL hero: shaders, WebGL helpers, glyph atlas, particle data and the frame loop |
| `src/scripts/visualiser/` | Visualiser: checks, line alignment, the filter call, each card's rendering, sticky controls and samples |
| `src/styles/` | The ice theme mapped onto Starlight's variables, plus hero, dock and visualiser styles |
| `scripts/` | The content preparation and link check steps |

## Vercel

`vercel.json` at the repository root holds the settings. Keep the Vercel project root at the repository root.

| Setting | Value |
| --- | --- |
| Framework preset | Other (`framework: null`) |
| Install command | `npm ci --ignore-scripts && npm ci --ignore-scripts --prefix site` |
| Build command | `npm run docs:build` |
| Output directory | `site/dist` |

The site is published at https://fonn.nord-forge.dev from the Vercel project `fonn`. Vercel's GitHub integration deploys `main` to production and builds preview deployments for pull requests. The repository's own CI only builds the site and never deploys. The site needs no environment variables and no provider credentials. `site` in `astro.config.mjs` holds the production address, which Astro also uses for the sitemap.
