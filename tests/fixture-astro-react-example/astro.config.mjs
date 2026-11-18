// From Astro's examples/framework-react (MIT).
// @ts-check

import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// Enable React to support React JSX components.
	integrations: [react()],
});
