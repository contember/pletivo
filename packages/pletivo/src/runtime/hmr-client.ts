/**
 * Dev-only HMR client. Injected into every page served by `pletivo dev`.
 *
 * Protocol (messages from server, via WS/SSE/poll):
 *   { "type": "css" }                — re-fetch the stylesheet, swap in place
 *   { "type": "html", "url"?: str }  — re-fetch the page HTML, morph the DOM
 *   { "type": "reload" }             — fall back to full reload
 *
 * Legacy plain-text "reload" is still honored so old clients still work.
 *
 * Transport priority: WebSocket → SSE → long-polling.
 * Falls back automatically when a transport fails to connect.
 *
 * The morph pass uses morphdom, loaded lazily on the first html-type
 * update. Islands (`<pletivo-island>` custom elements) are preserved by
 * identity across morph so their hydrated Preact state survives as long
 * as their component + serialized props are unchanged.
 */
export const hmrClientScript = `
<script type="module">
(function () {
  const BASE = location.origin;
  let morphdom = null;
  let transport = null; // "ws" | "sse" | "poll"

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

  // ── Transport layer ─────────────────────────────────────────────

  function handleMessage(raw) {
    let msg;
    try {
      msg = typeof raw === "string" && raw[0] === "{" ? JSON.parse(raw) : { type: raw };
    } catch {
      msg = { type: "reload" };
    }

    if (msg.type === "css") return swapCss();
    if (msg.type === "html") return morphPage();
    if (msg.type === "noop") return; // poll timeout, ignore
    location.reload();
  }

  // ── WebSocket ───────────────────────────────────────────────────

  function connectWs() {
    return new Promise(function (resolve) {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(protocol + "//" + location.host + "/__hmr");
      const timer = setTimeout(function () {
        ws.close();
        resolve(false);
      }, 5000);

      ws.onopen = function () {
        clearTimeout(timer);
        transport = "ws";
        console.log("[pletivo] HMR connected (WebSocket)");
        resolve(true);
      };
      ws.onmessage = function (e) { handleMessage(e.data); };
      ws.onclose = function () {
        clearTimeout(timer);
        if (transport === "ws") {
          transport = null;
          reconnect();
        } else {
          resolve(false);
        }
      };
      ws.onerror = function () { ws.close(); };
    });
  }

  // ── SSE ─────────────────────────────────────────────────────────

  function connectSse() {
    return new Promise(function (resolve) {
      const es = new EventSource(BASE + "/__hmr_sse");
      const timer = setTimeout(function () {
        es.close();
        resolve(false);
      }, 5000);

      es.onopen = function () {
        clearTimeout(timer);
        transport = "sse";
        console.log("[pletivo] HMR connected (SSE)");
        resolve(true);
      };
      es.onmessage = function (e) { handleMessage(e.data); };
      es.onerror = function () {
        clearTimeout(timer);
        es.close();
        if (transport === "sse") {
          transport = null;
          reconnect();
        } else {
          resolve(false);
        }
      };
    });
  }

  // ── Long-polling ────────────────────────────────────────────────

  function connectPoll() {
    transport = "poll";
    console.log("[pletivo] HMR connected (long-poll)");
    poll();
    return Promise.resolve(true);
  }

  function poll() {
    if (transport !== "poll") return;
    fetch(BASE + "/__hmr_poll", { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (data) {
        handleMessage(data);
        poll();
      })
      .catch(function () {
        transport = null;
        reconnect();
      });
  }

  // ── Connection management ───────────────────────────────────────

  async function connect() {
    if (await connectWs()) return;
    if (await connectSse()) return;
    await connectPoll();
  }

  function reconnect() {
    console.log("[pletivo] Connection lost. Reconnecting…");
    setTimeout(async function () {
      // Check if server is alive before attempting transport
      try {
        await fetch(BASE + "/__hmr_ping", { cache: "no-store" });
        connect();
      } catch {
        reconnect();
      }
    }, 1000);
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
        const mod = await import("/__pletivo/morphdom.js");
        morphdom = mod.default || mod.morphdom;
      } catch (err) {
        console.warn("[pletivo] morphdom load failed, falling back to reload", err);
        location.reload();
        return;
      }
    }

    // If the current page is an error overlay, skip morph — a full reload
    // is safer because the error page has a minimal DOM with no <head>
    // scripts, and morphdom can't execute scripts from DOMParser output.
    if (document.querySelector("[data-pletivo-error]")) {
      location.reload();
      return;
    }

    let html;
    try {
      const res = await fetch(location.href, {
        headers: { "X-Pletivo-HMR": "1" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      html = await res.text();
    } catch (err) {
      console.warn("[pletivo] re-fetch failed, reloading", err);
      location.reload();
      return;
    }

    // If the server returned an error page, reload instead of morphing
    // into a broken state where scripts won't execute.
    if (html.indexOf("data-pletivo-error") !== -1) {
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
          // Preserve stylesheets whose base href matches — ignore query
          // params so a CSS hot-swap's cache-bust suffix doesn't cause
          // morphdom to replace the link on the next HTML morph.
          if (
            fromEl.tagName === "LINK" &&
            toEl.tagName === "LINK"
          ) {
            const fromHref = (fromEl.getAttribute("href") || "").split("?")[0];
            const toHref = (toEl.getAttribute("href") || "").split("?")[0];
            if (fromHref === toHref) return false;
          }
          return !areElementsEqual(fromEl, toEl);
        },
        onBeforeNodeDiscarded: (node) => !shouldPreserveNode(node),
      });
    } catch (err) {
      console.warn("[pletivo] head morph failed", err);
    }

    try {
      morphdom(document.body, fresh.body, {
        onBeforeElUpdated: (fromEl, toEl) => {
          if (shouldPreserveNode(fromEl)) return false;
          // Islands: keep the live element if the component and serialized
          // props haven't changed. Pletivo island markers carry
          // data-component + data-props attributes.
          if (fromEl.tagName === "PLETIVO-ISLAND" && toEl.tagName === "PLETIVO-ISLAND") {
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
          if (node.nodeType === 1 && node.querySelector && node.querySelector("pletivo-island")) {
            console.log("[pletivo] island discarded during morph");
          }
        },
      });
    } catch (err) {
      console.warn("[pletivo] body morph failed, reloading", err);
      location.reload();
      return;
    } finally {
      bodyObserver.takeRecords();
      headObserver.takeRecords();
      observing = true;
    }

    // Re-hydrate any islands that were added or replaced by morphdom.
    // The initial hydration script marks islands with data-hydrated on
    // mount, so we only pick up new/changed ones here.
    if (typeof window.__pletivoHydrate === "function") {
      window.__pletivoHydrate();
    }
  }

  // Elements that survive morph as-is:
  //  1. Top-level runtime-injected nodes (direct children of body/head
  //     added after the initial server render). These are typically
  //     CMS editor hosts, portal roots, toast containers, devtool
  //     overlays — runtime UI the server never emitted.
  //  2. Pletivo's own HMR <script> — text-matched on the WS URL so the
  //     WebSocket doesn't get torn down mid-morph.
  //  3. Explicit escape hatch via data-pletivo-preserve attribute.
  function shouldPreserveNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (runtimeInjected.has(node)) return true;
    if (node.tagName === "SCRIPT" && node.textContent && node.textContent.indexOf("/__hmr") !== -1) {
      return true;
    }
    if (node.hasAttribute && node.hasAttribute("data-pletivo-preserve")) return true;
    return false;
  }

  function areElementsEqual(a, b) {
    if (a.isEqualNode && a.isEqualNode(b)) return true;
    return false;
  }

  connect();
})();
</script>`;
