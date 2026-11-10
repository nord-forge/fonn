// Astro and Starlight configuration for the Fonn docs site.
//
// The visualiser bundles the real compiled filter from packages/core/dist. Its
// archive module uses Node file APIs, so a browser stub replaces it here.
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const artifactStoreStub = fileURLToPath(new URL('./src/scripts/artifact-store-stub.js', import.meta.url));

export default defineConfig({
  outDir: './dist',
  integrations: [
    starlight({
      title: 'Fonn',
      description: 'A local CLI around native Claude Code and Codex. Saved model profiles, subagent guidance, and conservative filtering of noisy shell output with recoverable originals.',
      logo: { src: './public/favicon.svg', alt: '' },
      favicon: '/favicon.svg',
      customCss: [
        './src/styles/theme.css',
        './src/styles/hero.css',
        './src/styles/dock.css',
        './src/styles/visualiser.css',
        './src/styles/visualiser-cards.css',
        './src/styles/visualiser-pipeline.css',
        './src/styles/visualiser-output.css',
      ],
      components: {
        Hero: './src/components/Hero.astro',
        SocialIcons: './src/components/StarLink.astro',
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
        { label: 'Configuration', items: ['configuration/profiles', 'configuration/permissions-and-billing'] },
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
