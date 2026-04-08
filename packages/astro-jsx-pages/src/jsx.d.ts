/**
 * Augments React's JSX types to support Astro client directives.
 * Import this in your project or include in tsconfig.
 */

import 'react';

declare module 'react' {
  interface Attributes {
    /** Hydrate the component immediately on page load */
    'client:load'?: boolean;
    /** Hydrate the component when the browser is idle */
    'client:idle'?: boolean;
    /** Hydrate the component when it enters the viewport */
    'client:visible'?: boolean | { rootMargin?: string };
    /** Hydrate the component when a media query matches */
    'client:media'?: string;
    /** Skip SSR, only render on client */
    'client:only'?: 'react' | 'preact' | 'solid' | 'vue' | 'svelte' | string;
  }
}
