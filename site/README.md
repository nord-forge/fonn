# Fonn docs site

A small static site with two pages. `index.html` is the documentation. `how-it-works.html` is an interactive visualiser that runs the compiled core filter in the browser. There is no framework and no runtime dependency.

## Preview locally

```sh
npm ci --ignore-scripts
npm run docs:dev
```

This compiles the core, builds `site/dist` and serves it at http://127.0.0.1:4321/. It rebuilds when `site/src` changes; reload the page to see the result. Set `PORT` to use another port.

`npm run docs:build` builds without serving. `npm run build` stays focused on the CLI and core and does not build the site.

## How the build works

`scripts/docs/build.mjs` reads `site/src` and writes `site/dist`:

- The profile table is generated from `packages/core/dist/profiles.js`.
- `site/src/js/visualiser/samples.js` holds the illustrative observations. Every sample runs through the compiled filter and the build fails if a sample's expected decision no longer matches. The static before and after demo on the docs page comes from the same run.
- `packages/core/dist/filtering/index.js` and `adapters.js` are copied to `site/dist/filter/` for the visualiser. A browser stub replaces the file-backed artifact store.
- Every local link, asset and anchor across both pages is checked, and so is every relative import in the site's modules.

Sample character counts describe those samples only. They are not token, cost or accuracy benchmarks.

## Files

| File | Purpose |
| --- | --- |
| `src/index.html` | Docs page with `{{placeholder}}` slots filled at build time |
| `src/how-it-works.html` | Visualiser page |
| `src/styles/` | Stylesheet parts, one topic per file. `main.css` lists them in order and the build joins them into one `styles.css` |
| `src/js/app.js` | Entry for both pages: tabs, copy buttons, the section highlight and the mobile dock, one module each |
| `src/js/hero/` | WebGL hero on the docs page: shaders, WebGL helpers, glyph atlas, particle data and the frame loop |
| `src/js/visualiser/` | Visualiser: checks, line alignment, the filter call, each card's rendering and the sticky controls |
| `src/js/visualiser/samples.js` | Sample observations shared by the build and the visualiser |
| `src/favicon.svg` | Mark and favicon |

Both pages stay readable without JavaScript. The hero falls back to a CSS gradient when WebGL is unavailable and draws one still frame when reduced motion is requested.

## Vercel

`vercel.json` at the repository root holds the settings. Keep the Vercel project root at the repository root.

| Setting | Value |
| --- | --- |
| Framework preset | Other (`framework: null`) |
| Install command | `npm ci --ignore-scripts` |
| Build command | `npm run docs:build` |
| Output directory | `site/dist` |

The site needs no environment variables and no provider credentials. Publishing is done by the maintainer; CI only builds the site.
