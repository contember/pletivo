import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tsxPages from '@pavouk/astro-jsx-pages';

export default defineConfig({
  integrations: [react(), tsxPages()],
});
