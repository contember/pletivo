# Pletivo — Astro Compatibility TODOs

SSG-relevant gaps in Astro API surface support, ordered by priority.

## S-tier — Core, must work

- [001 — Scoped Style Injection](001-scoped-style-injection.md) — `renderHead()` is no-op, scoped `<style>` never reaches the page

## A-tier — Important for real projects

- [002 — Image Optimization](002-image-optimization.md) — `<Image>`, `<Picture>`, `getImage()` are stubbed
- [003 — client:only Directive](003-client-only-directive.md) — components needing browser APIs at render crash
- [005 — defineStyleVars](005-define-style-vars.md) — dynamic CSS custom properties from frontmatter/props

## B-tier — Unlocks integrations and specific use-cases

- [004 — injectRoute()](004-inject-route.md) — sitemap, RSS, robots.txt integrations broken
- [006 — Content Layer Custom Loaders](006-content-layer-custom-loaders.md) — CMS integrations need this
- [007 — astro:env Virtual Module](007-astro-env-module.md) — type-safe env variables
- [008 — CSS Modules](008-css-modules.md) — `.module.css` imports
- [009 — injectScript Stages](009-inject-script-stages.md) — `page-ssr` and `before-hydration` stages
- [010 — YAML Parser Limitations](010-yaml-parser-limitations.md) — anchors, multiline, flow syntax

## C-tier — Low priority / consider skipping

- [011 — View Transitions](011-view-transitions.md) — SPA-like navigation, better solved by dedicated libs
