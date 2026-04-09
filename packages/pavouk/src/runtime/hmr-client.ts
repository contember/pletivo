/**
 * Dev-only HMR client. Injected into every page served by `pavouk dev`.
 *
 * Protocol (WS messages from server):
 *   { "type": "css" }                — re-fetch the stylesheet, swap in place
 *   { "type": "html", "url"?: str }  — re-fetch the page HTML, morph the DOM
 *   { "type": "reload" }             — fall back to full reload
 *
 * Legacy plain-text "reload" is still honored so old clients still work.
 *
 * The morph pass uses morphdom, loaded lazily on the first html-type
 * update. Islands (`<pavouk-island>` custom elements) are preserved by
 * identity across morph so their hydrated Preact state survives as long
 * as their component + serialized props are unchanged.
 */
export const hmrClientScript = `
<script type="module">
(function () {
  const WS_URL = "ws://" + location.host + "/__hmr";
  let ws;
  let morphdom = null;

  // Track top-level runtime-injected elements so morph doesn't strip
  // them. We only watch *direct children* of <body> and <head>
  // (subtree: false) — any integration that mounts a portal root,
  // floating toolbar, toast container, or devtool overlay does so as
  // a top-level child, and restricting the observer this way avoids
  // the "deep mutation poisoning" failure mode where an integration
  // wrapping server elements would mark server content as runtime-
  // injected and break morph. Deep DOM changes go through morph
  // normally.
  const runtimeInjected = new WeakSet();
  let observing = true;
  function watchDirectChildren(parent) {
    const obs = new MutationObserver((mutations) => {
      if (!observing) return;
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        for (const node of m.addedNodes) {
          if (node && node.nodeType === 1) runtimeInjected.add(node);
        }
      }
    });
    obs.observe(parent, { childList: true, subtree: false });
    return obs;
  }
  const bodyObserver = watchDirectChildren(document.body);
  const headObserver = watchDirectChildren(document.head);

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onmessage = onMessage;
    ws.onclose = onClose;
    ws.onerror = () => ws.close();
  }

  function onClose() {
    console.log("[pavouk] Connection lost. Reconnecting…");
    setTimeout(function () {
      // On reconnect failure, fall back to full reload
      fetch("/__hmr_ping").then(() => location.reload()).catch(() => {
        setTimeout(onClose, 1000);
      });
    }, 1000);
  }

  async function onMessage(e) {
    let msg;
    try {
      msg = typeof e.data === "string" && e.data[0] === "{" ? JSON.parse(e.data) : { type: e.data };
    } catch {
      msg = { type: "reload" };
    }

    if (msg.type === "css") {
      return swapCss();
    }
    if (msg.type === "html") {
      return morphPage();
    }
    // "reload" or anything else
    location.reload();
  }

  // ── L1: CSS hot swap ────────────────────────────────────────────
  function swapCss() {
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    if (links.length === 0) {
      location.reload();
      return;
    }
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      // Only swap links that point at our dev stylesheet or hashed asset
      if (!/__styles\\.css|\\/assets\\/styles\\./.test(href)) continue;
      const fresh = link.cloneNode(false);
      // Cache-bust
      const u = new URL(href, location.href);
      u.searchParams.set("_v", Date.now().toString());
      fresh.href = u.pathname + u.search;
      fresh.addEventListener("load", () => link.remove(), { once: true });
      fresh.addEventListener("error", () => fresh.remove(), { once: true });
      link.after(fresh);
    }
  }

  // ── L2: HTML morph ──────────────────────────────────────────────
  async function morphPage() {
    if (!morphdom) {
      try {
        const mod = await import("/__pavouk/morphdom.js");
        morphdom = mod.default || mod.morphdom;
      } catch (err) {
        console.warn("[pavouk] morphdom load failed, falling back to reload", err);
        location.reload();
        return;
      }
    }

    let html;
    try {
      const res = await fetch(location.href, {
        headers: { "X-Pavouk-HMR": "1" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      html = await res.text();
    } catch (err) {
      console.warn("[pavouk] re-fetch failed, reloading", err);
      location.reload();
      return;
    }

    const parser = new DOMParser();
    const fresh = parser.parseFromString(html, "text/html");

    // If the document structure looks incompatible, just reload.
    if (!fresh.body || !fresh.documentElement) {
      location.reload();
      return;
    }

    // Pause observer during morph so morph's own add/remove operations
    // don't register as runtime injections. Drain any pending records
    // after morph via takeRecords() before re-enabling.
    observing = false;
    try {
      morphdom(document.head, fresh.head, {
        onBeforeElUpdated: (fromEl, toEl) => {
          if (shouldPreserveNode(fromEl)) return false;
          // Preserve stylesheets with identical href so CSS swap isn't
          // triggered by an unrelated HTML update
          if (
            fromEl.tagName === "LINK" &&
            toEl.tagName === "LINK" &&
            fromEl.getAttribute("href") === toEl.getAttribute("href")
          ) {
            return false;
          }
          return !areElementsEqual(fromEl, toEl);
        },
        onBeforeNodeDiscarded: (node) => !shouldPreserveNode(node),
      });
    } catch (err) {
      console.warn("[pavouk] head morph failed", err);
    }

    try {
      morphdom(document.body, fresh.body, {
        onBeforeElUpdated: (fromEl, toEl) => {
          if (shouldPreserveNode(fromEl)) return false;
          // Islands: keep the live element if the component and serialized
          // props haven't changed. Pavouk island markers carry
          // data-component + data-props attributes.
          if (fromEl.tagName === "PAVOUK-ISLAND" && toEl.tagName === "PAVOUK-ISLAND") {
            if (
              fromEl.getAttribute("data-component") === toEl.getAttribute("data-component") &&
              fromEl.getAttribute("data-props") === toEl.getAttribute("data-props")
            ) {
              return false;
            }
          }
          return !areElementsEqual(fromEl, toEl);
        },
        onBeforeNodeDiscarded: (node) => !shouldPreserveNode(node),
        onNodeDiscarded: (node) => {
          // If a dropped node contained an island, log so users know state is gone
          if (node.nodeType === 1 && node.querySelector && node.querySelector("pavouk-island")) {
            console.log("[pavouk] island discarded during morph");
          }
        },
      });
    } catch (err) {
      console.warn("[pavouk] body morph failed, reloading", err);
      location.reload();
      return;
    } finally {
      bodyObserver.takeRecords();
      headObserver.takeRecords();
      observing = true;
    }
  }

  // Elements that survive morph as-is:
  //  1. Top-level runtime-injected nodes (direct children of body/head
  //     added after the initial server render). These are typically
  //     CMS editor hosts, portal roots, toast containers, devtool
  //     overlays — runtime UI the server never emitted.
  //  2. Pavouk's own HMR <script> — text-matched on the WS URL so the
  //     WebSocket doesn't get torn down mid-morph.
  //  3. Explicit escape hatch via data-pavouk-preserve attribute.
  function shouldPreserveNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (runtimeInjected.has(node)) return true;
    if (node.tagName === "SCRIPT" && node.textContent && node.textContent.indexOf("/__hmr") !== -1) {
      return true;
    }
    if (node.hasAttribute && node.hasAttribute("data-pavouk-preserve")) return true;
    return false;
  }

  function areElementsEqual(a, b) {
    if (a.isEqualNode && a.isEqualNode(b)) return true;
    return false;
  }

  connect();
})();
</script>`;
