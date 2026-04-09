---
title: "Getting Started with Islands"
date: 2026-02-20
tags: [tutorial, islands]
---

# Getting Started with Islands

Islands let you add **interactivity** to your static pages without shipping a full JavaScript framework.

## How it works

1. Create a component in `src/islands/`
2. Export a `mount()` function
3. Use it in your page with `client="load"` prop

```tsx
// src/islands/Counter.tsx
export function mount(el, props) {
  let count = props.initial;
  const btn = el.querySelector("button");
  btn.onclick = () => {
    count++;
    btn.textContent = String(count);
  };
}
```

That's it! Your component will be bundled separately and hydrated on the client.
