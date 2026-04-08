import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tsxPages from '@anthropic/astro-jsx-pages';

export default defineConfig({
  integrations: [react(), tsxPages()],
});
