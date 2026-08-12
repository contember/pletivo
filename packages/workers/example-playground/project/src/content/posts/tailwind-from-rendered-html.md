---
title: Tailwind, generated from the page you just rendered
date: 2026-02-24
description: The scanner cannot walk a source tree, so it reads the finished HTML instead.
tags: [css, tailwind]
---

Tailwind normally finds your classes by scanning the source tree with a native
binary. Neither half of that works in an isolate: no tree, no native code. So the
order is reversed. The page renders first, and the HTML it produced becomes the
input to the CSS build.

This has one nice property and one sharp edge.

The nice property: a page carries only the utilities it uses. Nothing is shared,
nothing is unused, and there is no stylesheet to invalidate when an unrelated page
changes.

The sharp edge: a class that never appears in the output does not exist.

```astro
<!-- works -->
<p class="text-signal">signal</p>

<!-- generates nothing -->
<p class={`text-${color}-500`}>broken</p>
```

The second line is a rule you already live with in Tailwind, but here it is stricter,
because the scanner never sees your source at all — only the string that came out.

## Practical consequences

- Write class names in full. Map a variable to whole class strings, not to fragments.
- A class only used inside a `<style>` block is not a candidate; put it in the markup.
- Theme values are different: `@theme` in your CSS is read as CSS, so custom colors
  and spacing work exactly as documented.

Try it — add `text-signal` to any element and the rule appears in this page's inline
stylesheet on the next render.
