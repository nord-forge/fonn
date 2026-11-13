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
| `src/components/QuickNavigation/` | First-Tab navigation panel: skip to content, search, page sections and links generated from the sidebar |
| `src/components/Header/` · `src/components/DesktopNavigation/` | Default Starlight header plus a primary navigation row at 72rem and wider |
| `src/scripts/dock.js` | The mobile section dock, which replaces Starlight's mobile menu and "On this page" bar |
| `src/scripts/hero/` | WebGL hero: shaders, WebGL helpers, glyph atlas, particle data and the frame loop |
| `src/scripts/visualiser/` | Visualiser: checks, line alignment, the filter call, each card's rendering, sticky controls and samples |
| `src/styles/` | The ice theme mapped onto Starlight's variables, plus hero, dock and visualiser styles |
| `scripts/` | The content preparation and link check steps |

The first Tab reveals **Quick navigation**, with **Skip to main content** first. Tab and Shift+Tab move through ordinary links and buttons; Enter follows a link, and Escape or Close returns focus to the header. Page-section links move keyboard focus to their heading. Reference guides use a native disclosure so the main destinations stay compact. Without JavaScript, the skip link and documentation links still work. The existing mobile dock stays in place; the additional header navigation only appears at desktop widths.

## Vercel

`vercel.json` at the repository root holds the settings. Keep the Vercel project root at the repository root.

| Setting | Value |
| --- | --- |
| Framework preset | Other (`framework: null`) |
| Install command | `npm ci --ignore-scripts && npm ci --ignore-scripts --prefix site` |
| Build command | `npm run docs:build` |
| Output directory | `site/dist` |

The site is published at https://fonn.nord-forge.dev from the Vercel project `fonn`. Deploys are manual and prebuilt: the site is built on the maintainer's machine and Vercel only receives the finished output. `vercel.json` sets `git.deploymentEnabled` to `false`, so pushes and pull requests do not build on Vercel, and the repository's CI only builds the site.

To deploy, from a clean checkout of `main` with the Vercel CLI signed in (`vercel login`):

```sh
npm run docs:deploy               # production
npm run docs:deploy -- --preview  # a preview deployment
```

`scripts/docs-deploy.mjs` refuses to run with uncommitted changes and warns when the checkout is not an up-to-date `main`. It runs `vercel pull`, `vercel build` and `vercel deploy --prebuilt`, with the project's IDs passed as environment variables, so the folder is never linked. Vercel's files go in the ignored `.vercel/` folder.

The site needs no environment variables and no provider credentials. `site` in `astro.config.mjs` holds the production address, which Astro also uses for the sitemap.
