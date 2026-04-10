/**
 * Client-side hydration runtime.
 * This is injected as a script into pages that use islands.
 * It finds <pletivo-island> elements and hydrates them according to their strategy.
 */

export const hydrationScript = `
<script type="module">
window.__pletivoHydrate = hydrateIslands;
hydrateIslands();

async function hydrateIsland(el) {
  const name = el.dataset.component;
  const props = JSON.parse(el.dataset.props);
  try {
    const mod = await import("/_islands/" + name + ".js");
    if (typeof mod.mount === "function") {
      mod.mount(el, props);
      el.dataset.hydrated = "1";
    }
  } catch (e) {
    console.error("[pletivo] Failed to hydrate island " + name + ":", e);
  }
}

function hydrateIslands() {
  const islands = document.querySelectorAll('pletivo-island:not([data-hydrated])');
  islands.forEach(el => {
    const strategy = el.dataset.hydrate;

    if (strategy === "load") {
      hydrateIsland(el);
    } else if (strategy === "idle") {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(() => hydrateIsland(el));
      } else {
        setTimeout(() => hydrateIsland(el), 200);
      }
    } else if (strategy === "visible") {
      const observer = new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            hydrateIsland(el);
            obs.disconnect();
          }
        }
      });
      observer.observe(el);
    } else if (strategy.startsWith("media(")) {
      const query = strategy.slice(6, -1);
      const mql = window.matchMedia(query);
      if (mql.matches) {
        hydrateIsland(el);
      } else {
        mql.addEventListener("change", (e) => {
          if (e.matches) hydrateIsland(el);
        }, { once: true });
      }
    }
  });
}
</script>`;
