# Fonn brand

The Fonn mark is one horizontal line settling inside a quiet rounded frame: the one signal that survives the noise. These are the files the repository, the docs site and `fonn ui` use. Launch and social media artwork is kept outside the repository.

The `dark` files are for dark backgrounds, with light lines and lettering. The `light` files are for white and light backgrounds.

| Folder | Files | Used for |
| --- | --- | --- |
| `logos/` | The mark alone (`fonn-mark-*`), and the mark with the wordmark side by side (`fonn-horizontal-*`) or stacked (`fonn-stacked-*`). SVG masters and transparent PNGs. `-mono` marks use one colour. | The README header, and anywhere the logo appears. |
| `icons/` | The app icon at 1024 by 1024, and favicons as SVG, ICO and PNG from 16 to 180 pixels. | The GitHub avatar, the docs site favicon and `fonn ui`. |
| `social/` | The GitHub social preview, 1280 by 640. | GitHub's repository settings and the docs site link preview (`site/public/og.png`). |

`colors.css` holds the palette as CSS variables. It is the same "ice" palette as `fonn ui`:

| Token | Value | Use |
| --- | --- | --- |
| Night | `#09131d` | Dark background |
| Surface | `#0f1e2d` | Dark panels and the icon tile |
| Ice | `#84bdf3` | The line, accents on dark |
| Light ice | `#a9d1f7` | The frame, strong accents on dark |
| Snow | `#e3eef8` | Text on dark |
| Frost | `#a2b8cc` | Secondary text on dark |
| Deep | `#0e2236` | Text on white |
| Blue | `#1d5fa8` | The mark and accents on white |

The wordmark is lowercase `fonn` in Inter Display Bold with slightly tight letter spacing. In the SVG lockups it is live text, so they need Inter installed to render as designed. Use the PNGs where Inter may be missing, such as on GitHub.

Keep the mark at least 16 pixels square, with clear space of at least 15% of its width on every side. Do not add gradients, photos, 3D effects or decorative snowflakes.

These brand files are licensed under [CC BY 4.0](LICENSE): you may share and adapt them, also commercially, if you credit "Fonn logo by Fonn contributors, CC BY 4.0" with a link to this repository and say if you changed them. The licence does not let anyone suggest the Fonn project endorses them. The code is MIT licensed, in the root [LICENSE](../LICENSE).
