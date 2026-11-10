import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Optional UI string overrides; src/content/i18n/en.json renames a few labels.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
