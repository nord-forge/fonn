// Astro and Starlight configuration for the Fonn docs site.
//
// The visualiser bundles the real compiled filter from packages/core/dist. Its
// archive module uses Node file APIs, so a browser stub replaces it here.
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const artifactStoreStub = fileURLToPath(new URL('./src/scripts/artifact-store-stub.js', import.meta.url));

export default defineConfig({
  // Production address; also enables the sitemap.
  site: 'https://fonn.nord-forge.dev',
  outDir: './dist',
  integrations: [
    starlight({
      title: 'Fonn',
      description: 'Fonn shortens noisy command output before your coding agent reads it. One hook for Claude Code, Codex, Crush and OpenCode, with every original kept on your machine.',
      // The brand mark from brand/logos: light lines on the dark theme, dark blue on the light one.
      logo: { dark: './src/assets/brand/mark-dark.svg', light: './src/assets/brand/mark-light.svg', alt: '' },
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '48x48' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        // The link preview for GitHub, LinkedIn and chat apps: brand/social/fonn-github-dark.png.
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://fonn.nord-forge.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1280' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '640' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'fonn. Your CLI, a little clearer.' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://fonn.nord-forge.dev/og.png' } },
      ],
      customCss: [
        './src/styles/theme.css',
        './src/styles/hero.css',
        './src/styles/dock.css',
        './src/styles/theme-select.css',
        './src/styles/visualiser.css',
        './src/styles/visualiser-cards.css',
        './src/styles/visualiser-pipeline.css',
        './src/styles/visualiser-output.css',
      ],
      components: {
        SkipLink: './src/components/QuickNavigation/QuickNavigation.astro',
        Header: './src/components/Header/Header.astro',
        Hero: './src/components/Hero.astro',
        SocialIcons: './src/components/StarLink.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        // The section dock (src/scripts/dock.js) replaces the mobile "On this
        // page" bar and the mobile menu button on every page. Head passes it
        // the page headings and the docs navigation.
        Head: './src/components/Head.astro',
        MobileTableOfContents: './src/components/Empty.astro',
        MobileMenuToggle: './src/components/Empty.astro',
      },
      sidebar: [
        { label: 'Start here', items: ['start/overview', 'start/install', 'start/everyday-use'] },
        { label: 'Filtering', items: ['filtering/formats', 'filtering/levels', { label: 'Interactive visualiser', link: '/how-it-works/' }] },
        { label: 'Configuration', items: ['configuration/profiles', { label: 'Project settings', link: '/reference/project-settings/' }, 'configuration/permissions-and-billing'] },
        { label: 'Help', items: ['help/faq', 'help/links'] },
        { label: 'Reference', collapsed: true, items: [{ autogenerate: { directory: 'reference' } }] },
      ],
      editLink: { baseUrl: 'https://github.com/nord-forge/fonn/edit/main/site/' },
      // Wrap long lines in code blocks instead of scrolling sideways on phones.
      expressiveCode: { defaultProps: { wrap: true } },
      lastUpdated: false,
    }),
  ],
  vite: {
    resolve: {
      alias: [{ find: /^\.\/artifact-store\.js$/, replacement: artifactStoreStub }],
    },
  },
});
