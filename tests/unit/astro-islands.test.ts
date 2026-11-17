import { afterEach, describe, expect, test } from "bun:test";
import "../../packages/runtime/src/astro-shim";
import {
  configureAstroIslands,
  finalizeIslandScripts,
  hoistIslandScripts,
  renderFrameworkComponent,
  type FrameworkComponentCall,
  type LoadedRenderer,
  type RenderedSlots,
  type RendererMetadata,
  type RendererServer,
} from "../../packages/runtime/src/astro-islands";
import { serializeProps } from "../../packages/runtime/src/astro-islands/serialize";
import { createHtml } from "../../packages/runtime/src/html-string";

/**
 * Expected markup is quoted from Astro 5.16.11 builds of its official examples, except
 * the island element script (3.4 kB, passed through as configured), stood in for here.
 */
// The uids hash the absolute path; they were recomputed with astro@5.16.11's own shorthash for this ROOT.
const ROOT = "/project";

const ISLAND_SCRIPT = "/*astro-island.prebuilt.js*/";
const VISIBLE =
  '(()=>{var a=(s,i,o)=>{let r=async()=>{await(await s())()},t=typeof i.value=="object"?i.value:void 0,c={rootMargin:t==null?void 0:t.rootMargin},n=new IntersectionObserver(e=>{for(let l of e)if(l.isIntersecting){n.disconnect(),r();break}},c);for(let e of o.children)n.observe(e)};(self.Astro||(self.Astro={})).visible=a;window.dispatchEvent(new Event("astro:visible"));})();';
const LOAD =
  '(()=>{var e=async t=>{await(await t())()};(self.Astro||(self.Astro={})).load=e;window.dispatchEvent(new Event("astro:load"));})();';
const IDLE =
  '(()=>{var l=(n,t)=>{let i=async()=>{await(await n())()},e=typeof t.value=="object"?t.value:void 0,s={timeout:e==null?void 0:e.timeout};"requestIdleCallback"in window?window.requestIdleCallback(i,s):setTimeout(i,s.timeout||200)};(self.Astro||(self.Astro={})).idle=l;window.dispatchEvent(new Event("astro:idle"));})();';
const SOLID_HYDRATION =
  '<script>window._$HY||(e=>{let t=e=>e&&e.hasAttribute&&(e.hasAttribute("data-hk")?e:t(e.host&&e.host.nodeType?e.host:e.parentNode));["click", "input"].forEach((o=>document.addEventListener(o,(o=>{if(!e.events)return;let s=t(o.composedPath&&o.composedPath()[0]||o.target);s&&!e.completed.has(s)&&e.events.push([s,o])}))))})(_$HY={events:[],completed:new WeakSet,r:{},fe(){}});</script><!--xs-->';
const STYLE = "<style>astro-island,astro-slot,astro-static-slot{display:contents}</style>";
const BOTH_VISIBLE = `${STYLE}<script>${VISIBLE}</script><script>${ISLAND_SCRIPT}</script>`;
const BOTH_LOAD = `${STYLE}<script>${LOAD}</script><script>${ISLAND_SCRIPT}</script>`;

// ── Fake renderers, modelled on each integration's dist/server.js ─────────────

interface FakeVNode {
  framework: string;
  render(slot: string, id: string): string;
}

function isVNode(value: unknown, framework: string): value is FakeVNode {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "framework") === framework &&
    typeof Reflect.get(value, "render") === "function"
  );
}

function callComponent(Component: unknown, props: Record<string, unknown>): unknown {
  if (typeof Component !== "function") throw new TypeError("component is not a function");
  return Reflect.apply(Component, undefined, [props]);
}

/** Async render work, like a stream read: lets other islands' calls interleave. */
async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

function counter(prefix: string) {
  const ids = new WeakMap<object, number>();
  return (result: object): string => {
    const next = ids.get(result) ?? 0;
    ids.set(result, next + 1);
    return `${prefix}${next}`;
  };
}

/** Each integration's StaticHtml: no `<astro-slot>` when `!value`, so an empty `""` slot would vanish. */
function slotHtml(slots: RenderedSlots, metadata: RendererMetadata | undefined): string {
  const tag = metadata?.astroStaticSlot && !metadata.hydrate ? "astro-static-slot" : "astro-slot";
  const value = slots.default;
  return value ? `<${tag}>${value}</${tag}>` : "";
}

/** @astrojs/react: `check` renders a Tester through `renderToStaticMarkup`, spending a prefix id. */
function reactServer(calls: string[] = []): RendererServer {
  const incrementId = counter("r");
  async function renderToStaticMarkup(
    this: { result: object },
    Component: unknown,
    props: Record<string, unknown>,
    slots: RenderedSlots,
    metadata?: RendererMetadata,
  ) {
    const prefix = incrementId(this.result);
    calls.push(`react ${prefix}`);
    delete props["class"];
    const vnode = callComponent(Component, props);
    await ticks(4);
    const html = isVNode(vnode, "react") ? vnode.render(slotHtml(slots, metadata), prefix) : "<div></div>";
    return { html, attrs: { prefix } };
  }
  return {
    name: "@astrojs/react",
    async check(Component, props, slots) {
      if (typeof Component === "object" && Component !== null) {
        const tag: unknown = Reflect.get(Component, "$$typeof");
        if (typeof tag !== "symbol") throw new TypeError("Cannot read properties of undefined (reading 'toString')");
        return tag.toString().slice("Symbol(".length).startsWith("react");
      }
      if (typeof Component !== "function") return false;
      let isReact = false;
      const Tester = (testerProps: Record<string, unknown>) => {
        try {
          isReact = isVNode(callComponent(Component, testerProps), "react");
        } catch {
          // React's Tester swallows a component that throws.
        }
        return null;
      };
      await renderToStaticMarkup.call(this, Tester, props, slots);
      return isReact;
    },
    renderToStaticMarkup,
    supportsAstroStaticSlot: true,
  };
}

function isSignal(value: unknown): value is { peek(): unknown } {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "peek") === "function" && "value" in value;
}

/** @astrojs/preact: `check` renders, and a signal prop is replaced by its value on the props object it gets. */
function preactServer(calls: string[] = []): RendererServer {
  const signalIds = new WeakMap<object, Map<object, string>>();
  async function renderToStaticMarkup(
    this: { result: object },
    Component: unknown,
    props: Record<string, unknown>,
    slots: RenderedSlots,
    metadata?: RendererMetadata,
  ) {
    calls.push("preact render");
    const ids = signalIds.get(this.result) ?? new Map<object, string>();
    signalIds.set(this.result, ids);
    const signals: Record<string, string> = {};
    for (const [key, value] of Object.entries(props)) {
      if (!isSignal(value)) continue;
      props[key] = value.peek();
      const id = ids.get(value) ?? `p${ids.size}`;
      ids.set(value, id);
      signals[key] = id;
    }
    const attrs: Record<string, string> = {};
    if (Object.keys(signals).length) attrs["data-preact-signals"] = JSON.stringify(signals);
    const vnode = callComponent(Component, props);
    if (!isVNode(vnode, "preact")) throw new Error("not a Preact component");
    await ticks(2);
    return { attrs, html: vnode.render(slotHtml(slots, metadata), "") };
  }
  return {
    name: "@astrojs/preact",
    async check(Component, props, slots) {
      if (typeof Component !== "function") return false;
      try {
        const { html } = await renderToStaticMarkup.call(this, Component, props, slots, undefined);
        return html !== "";
      } catch {
        return false;
      }
    },
    renderToStaticMarkup,
    supportsAstroStaticSlot: true,
  };
}

/** @astrojs/solid-js: a render id only for hydrated renders, and a hydration script per page. */
function solidServer(): RendererServer {
  const incrementId = counter("s");
  async function renderToStaticMarkup(
    this: { result: object },
    Component: unknown,
    props: Record<string, unknown>,
    slots: RenderedSlots,
    metadata?: RendererMetadata,
  ) {
    const renderId = metadata?.hydrate ? incrementId(this.result) : "";
    const vnode = callComponent(Component, props);
    if (!isVNode(vnode, "solid")) throw new Error("not a Solid component");
    await ticks(1);
    return { attrs: { "data-solid-render-id": renderId }, html: vnode.render(slotHtml(slots, metadata), renderId) };
  }
  return {
    name: "@astrojs/solid",
    async check(Component, props, slots) {
      if (typeof Component !== "function") return false;
      if (Component.toString().includes("$$payload")) return false;
      try {
        await renderToStaticMarkup.call(this, Component, props, slots, undefined);
        return true;
      } catch {
        return false;
      }
    },
    renderToStaticMarkup,
    supportsAstroStaticSlot: true,
    renderHydrationScript: () => SOLID_HYDRATION,
  };
}

function templateOf(Component: unknown): (slot: string) => string {
  const template: unknown = Reflect.get(Object(Component), "template");
  if (typeof template !== "function") throw new Error("no template");
  return (slot) => String(Reflect.apply(template, undefined, [slot]));
}

/** @astrojs/svelte: `check` is a string test of the compiled function; its id is never an attribute. */
function svelteServer(): RendererServer {
  return {
    name: "@astrojs/svelte",
    check(Component) {
      if (typeof Component !== "function") return false;
      const source = Component.toString();
      return source.includes("$$payload") || source.includes("$$renderer");
    },
    async renderToStaticMarkup(Component, _props, slots, metadata) {
      await ticks(1);
      return { html: templateOf(Component)(slotHtml(slots, metadata)) };
    },
    supportsAstroStaticSlot: true,
  };
}

/** @astrojs/vue: an SFC object with `ssrRender`, and a per-page `s<n>` prefix of its own. */
function vueServer(): RendererServer {
  const incrementId = counter("s");
  return {
    name: "@astrojs/vue",
    async check(Component) {
      return typeof Component === "object" && Component !== null && "ssrRender" in Component;
    },
    async renderToStaticMarkup(Component, _props, slots, metadata) {
      const prefix = incrementId(this.result);
      await ticks(1);
      return { html: templateOf(Component)(slotHtml(slots, metadata)), attrs: { prefix } };
    },
    supportsAstroStaticSlot: true,
  };
}

// ── Fake components ───────────────────────────────────────────────────────────

const COUNTER = "<div class=\"counter\"><button>-</button><pre>0</pre><button>+</button></div>";

function component(framework: string, name: string, render: (slot: string, id: string) => string) {
  const fn = (_props: Record<string, unknown>): FakeVNode => ({ framework, render });
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

const ReactCounter = component("react", "Counter", (slot) => `${COUNTER}<div class="counter-message">${slot}</div>`);
const PreactCounter = component("preact", "PreactCounter", (slot) => `${COUNTER}<div class="counter-message">${slot}</div>`);
const SolidCounter = component(
  "solid",
  "SolidCounter",
  (slot, id) =>
    `<div data-hk="${id}0000" id="solid" class="counter"><button>-</button><pre>0</pre><button>+</button></div><div data-hk="${id}0001" class="counter-message">${slot}</div>`,
);
const VueCounter = {
  ssrRender: true,
  template: (slot: string) =>
    `<!--[-->${COUNTER}<div class="counter-message"><!--[-->${slot}<!--]--></div><!--]-->`,
};
const SvelteCounter = Object.assign(
  function SvelteCounter($$renderer: unknown) {
    return $$renderer;
  },
  {
    template: (slot: string) =>
      `<!--[--><div class="counter"><button>-</button> <pre>0</pre> <button>+</button></div> <div class="counter-message">${slot}<!----></div><!--]-->`,
  },
);

// ── Harness ───────────────────────────────────────────────────────────────────

function renderer(name: string, ssr: RendererServer, client: string | null = `${name}/client.js`): LoadedRenderer {
  return { name, clientEntrypoint: client, ssr };
}

function configure(
  renderers: LoadedRenderer[],
  components: Record<string, string>,
  rendererUrls: Record<string, string>,
  beforeHydration: string | null = null,
): void {
  configureAstroIslands({
    renderers,
    urls: {
      component(path, exportName) {
        const url = components[`${path}#${exportName}`];
        if (!url) throw new Error(`no client URL for ${path}#${exportName}`);
        return url;
      },
      renderer(name) {
        const url = rendererUrls[name];
        if (!url) throw new Error(`no renderer URL for ${name}`);
        return url;
      },
      beforeHydration,
    },
    scripts: { island: ISLAND_SCRIPT, directives: { load: LOAD, idle: IDLE, visible: VISIBLE, media: "/*media*/", only: "/*only*/" } },
  });
}

afterEach(() => configureAstroIslands(null));

function hydrated(directive: string, path: string, exportName = "default", value: unknown = true): Record<string, unknown> {
  return {
    [`client:${directive}`]: value,
    "client:component-hydration": directive,
    "client:component-path": path,
    "client:component-export": exportName,
  };
}

function slot(html: string) {
  return { default: () => createHtml(html) };
}

/** Start a call the way a compiled template does: synchronously, in document order. */
function offer(call: Omit<FrameworkComponentCall, "source" | "slots"> & Partial<FrameworkComponentCall>) {
  const pending = renderFrameworkComponent({ source: "astro", slots: {}, ...call });
  if (!pending) throw new Error("islands are not configured");
  return pending;
}

async function html(pending: ReturnType<typeof offer>): Promise<string> {
  const rendered = await pending;
  if (!rendered) throw new Error(`no renderer claimed the component`);
  return rendered.__html;
}

// ── Astro's examples ──────────────────────────────────────────────────────────

describe("Astro's framework examples", () => {
  test("framework-multiple: checks run per island in registration order, concurrently", async () => {
    const reactCalls: string[] = [];
    configure(
      [
        renderer("@astrojs/preact", preactServer()),
        renderer("@astrojs/solid-js", solidServer()),
        renderer("@astrojs/react", reactServer(reactCalls)),
        renderer("@astrojs/svelte", svelteServer()),
        renderer("@astrojs/vue", vueServer()),
      ],
      {
        [`${ROOT}/framework-multiple/src/components/react/ReactCounter#Counter`]: "/_astro/ReactCounter.CVXehPEa.js",
        [`${ROOT}/framework-multiple/src/components/preact/PreactCounter#PreactCounter`]: "/_astro/PreactCounter.Dfy_l3S5.js",
        [`${ROOT}/framework-multiple/src/components/solid/SolidCounter#default`]: "/_astro/SolidCounter.CUTQh-Of.js",
        [`${ROOT}/framework-multiple/src/components/vue/VueCounter.vue#default`]: "/_astro/VueCounter.DEFBY3Cs.js",
        [`${ROOT}/framework-multiple/src/components/svelte/SvelteCounter.svelte#default`]: "/_astro/SvelteCounter.DAujg8xl.js",
      },
      {
        "@astrojs/preact": "/_astro/client.CgapTuwn.js",
        "@astrojs/solid-js": "/_astro/client.elDWt4IS.js",
        "@astrojs/react": "/_astro/client.CimA0ymp.js",
        "@astrojs/svelte": "/_astro/client.svelte.BUcUh1Kb.js",
        "@astrojs/vue": "/_astro/client.BOaMyWMi.js",
      },
    );
    const result = {};
    const dir = `${ROOT}/framework-multiple/src/components`;
    const islands = [
      offer({ result, displayName: "react.Counter", Component: ReactCounter, props: hydrated("visible", `${dir}/react/ReactCounter`, "Counter"), slots: slot(" <h1>Hello from React!</h1> ") }),
      offer({ result, displayName: "PreactCounter", Component: PreactCounter, props: hydrated("visible", `${dir}/preact/PreactCounter`, "PreactCounter"), slots: slot(" <h1>Hello from Preact!</h1> ") }),
      offer({ result, displayName: "SolidCounter", Component: SolidCounter, props: hydrated("visible", `${dir}/solid/SolidCounter`), slots: slot(" <h1>Hello from Solid!</h1> ") }),
      offer({ result, displayName: "VueCounter", Component: VueCounter, props: hydrated("visible", `${dir}/vue/VueCounter.vue`), slots: slot(" <h1>Hello from Vue!</h1> ") }),
      offer({ result, displayName: "SvelteCounter", Component: SvelteCounter, props: hydrated("visible", `${dir}/svelte/SvelteCounter.svelte`), slots: slot(" <h1>Hello from Svelte!</h1> ") }),
    ];
    const page = `<main> ${(await Promise.all(islands.map(html))).join(" ")} </main>`;

    // React's check on react.Counter took r0 and its check on SvelteCounter r1, before the real render.
    expect(reactCalls).toEqual(["react r0", "react r1", "react r2"]);
    expect(finalizeIslandScripts(page)).toBe(
      `<main> ${BOTH_VISIBLE}<astro-island uid="Z2fKs27" prefix="r2" component-url="/_astro/ReactCounter.CVXehPEa.js" component-export="Counter" renderer-url="/_astro/client.CimA0ymp.js" props="{}" ssr client="visible" opts="{&quot;name&quot;:&quot;react.Counter&quot;,&quot;value&quot;:true}" await-children><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="counter-message"><astro-slot> <h1>Hello from React!</h1> </astro-slot></div><!--astro:end--></astro-island> <astro-island uid="Z1M02zB" component-url="/_astro/PreactCounter.Dfy_l3S5.js" component-export="PreactCounter" renderer-url="/_astro/client.CgapTuwn.js" props="{}" ssr client="visible" opts="{&quot;name&quot;:&quot;PreactCounter&quot;,&quot;value&quot;:true}" await-children><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="counter-message"><astro-slot> <h1>Hello from Preact!</h1> </astro-slot></div><!--astro:end--></astro-island> ${SOLID_HYDRATION}<astro-island uid="K5Rq5" data-solid-render-id="s0" component-url="/_astro/SolidCounter.CUTQh-Of.js" component-export="default" renderer-url="/_astro/client.elDWt4IS.js" props="{}" ssr client="visible" opts="{&quot;name&quot;:&quot;SolidCounter&quot;,&quot;value&quot;:true}" await-children><div data-hk="s00000" id="solid" class="counter"><button>-</button><pre>0</pre><button>+</button></div><div data-hk="s00001" class="counter-message"><astro-slot> <h1>Hello from Solid!</h1> </astro-slot></div><!--astro:end--></astro-island> <astro-island uid="ZnJEVH" prefix="s0" component-url="/_astro/VueCounter.DEFBY3Cs.js" component-export="default" renderer-url="/_astro/client.BOaMyWMi.js" props="{}" ssr client="visible" opts="{&quot;name&quot;:&quot;VueCounter&quot;,&quot;value&quot;:true}" await-children><!--[--><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="counter-message"><!--[--><astro-slot> <h1>Hello from Vue!</h1> </astro-slot><!--]--></div><!--]--><!--astro:end--></astro-island> <astro-island uid="2t81l2" component-url="/_astro/SvelteCounter.DAujg8xl.js" component-export="default" renderer-url="/_astro/client.svelte.BUcUh1Kb.js" props="{}" ssr client="visible" opts="{&quot;name&quot;:&quot;SvelteCounter&quot;,&quot;value&quot;:true}" await-children><!--[--><div class="counter"><button>-</button> <pre>0</pre> <button>+</button></div> <div class="counter-message"><astro-slot> <h1>Hello from Svelte!</h1> </astro-slot><!----></div><!--]--><!--astro:end--></astro-island> </main>`,
    );
  });

  test("framework-preact: check rewrites a signal prop on the serialized props, and both islands share its id", async () => {
    configure(
      [renderer("@astrojs/preact", preactServer())],
      { [`${ROOT}/framework-preact/src/components/Counter#default`]: "/_astro/Counter.Dj-yDL0k.js" },
      { "@astrojs/preact": "/_astro/client.C8kEtPzU.js" },
    );
    const Counter = component("preact", "Counter", (s) => `${COUNTER}<div class="message">${s}</div>`);
    const count = { value: 0, peek: () => 0 };
    const result = {};
    const props = () => ({
      count,
      ...hydrated("visible", `${ROOT}/framework-preact/src/components/Counter`),
      "data-astro-cid-j7pv25f6": true,
    });
    const islands = [
      offer({ result, displayName: "Counter", Component: Counter, props: props(), slots: slot(" <h1 data-astro-cid-j7pv25f6>Hello, Preact 1!</h1> ") }),
      offer({ result, displayName: "Counter", Component: Counter, props: props(), slots: slot(" <h1 data-astro-cid-j7pv25f6>Hello, Preact 2!</h1> ") }),
    ];
    const page = `<main data-astro-cid-j7pv25f6> ${(await Promise.all(islands.map(html))).join(" ")} </main>`;
    expect(finalizeIslandScripts(page)).toBe(
      `<main data-astro-cid-j7pv25f6> ${BOTH_VISIBLE}<astro-island uid="ZiYIEq" data-preact-signals="{&quot;count&quot;:&quot;p0&quot;}" component-url="/_astro/Counter.Dj-yDL0k.js" component-export="default" renderer-url="/_astro/client.C8kEtPzU.js" props="{&quot;count&quot;:[0,0],&quot;data-astro-cid-j7pv25f6&quot;:[0,true]}" ssr client="visible" opts="{&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:true}" await-children><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="message"><astro-slot> <h1 data-astro-cid-j7pv25f6>Hello, Preact 1!</h1> </astro-slot></div><!--astro:end--></astro-island> <astro-island uid="bivmF" data-preact-signals="{&quot;count&quot;:&quot;p0&quot;}" component-url="/_astro/Counter.Dj-yDL0k.js" component-export="default" renderer-url="/_astro/client.C8kEtPzU.js" props="{&quot;count&quot;:[0,0],&quot;data-astro-cid-j7pv25f6&quot;:[0,true]}" ssr client="visible" opts="{&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:true}" await-children><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="message"><astro-slot> <h1 data-astro-cid-j7pv25f6>Hello, Preact 2!</h1> </astro-slot></div><!--astro:end--></astro-island> </main>`,
    );
  });

  test("framework-react: the only island's prefix is r1, its check having spent r0", async () => {
    configure(
      [renderer("@astrojs/react", reactServer())],
      { [`${ROOT}/framework-react/src/components/Counter#default`]: "/_astro/Counter.BheZmnkF.js" },
      { "@astrojs/react": "/_astro/client.CimA0ymp.js" },
    );
    const Counter = component("react", "Counter", (s) => `${COUNTER}<div class="counter-message">${s}</div>`);
    const out = await html(
      offer({
        result: {},
        displayName: "Counter",
        Component: Counter,
        props: { count: 0, ...hydrated("visible", `${ROOT}/framework-react/src/components/Counter`), "data-astro-cid-j7pv25f6": true },
        slots: slot(" <h1 data-astro-cid-j7pv25f6>Hello, React!</h1> "),
      }),
    );
    expect(finalizeIslandScripts(out)).toBe(
      `${BOTH_VISIBLE}<astro-island uid="15tsS1" prefix="r1" component-url="/_astro/Counter.BheZmnkF.js" component-export="default" renderer-url="/_astro/client.CimA0ymp.js" props="{&quot;count&quot;:[0,0],&quot;data-astro-cid-j7pv25f6&quot;:[0,true]}" ssr client="visible" opts="{&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:true}" await-children><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="counter-message"><astro-slot> <h1 data-astro-cid-j7pv25f6>Hello, React!</h1> </astro-slot></div><!--astro:end--></astro-island>`,
    );
  });

  test("framework-solid: Solid's hydration script follows the island prescripts, once per page", async () => {
    configure(
      [renderer("@astrojs/solid-js", solidServer())],
      { [`${ROOT}/framework-solid/src/components/Counter#default`]: "/_astro/Counter.CWQ4vaRE.js" },
      { "@astrojs/solid-js": "/_astro/client.elDWt4IS.js" },
    );
    const Counter = component(
      "solid",
      "Counter",
      (s, id) =>
        `<div data-hk="${id}0000" class="counter"><button>-</button><pre>0</pre><button>+</button></div><div data-hk="${id}0001" class="counter-message">${s}</div>`,
    );
    const result = {};
    const call = (text: string) =>
      offer({
        result,
        displayName: "Counter",
        Component: Counter,
        props: { ...hydrated("visible", `${ROOT}/framework-solid/src/components/Counter`), "data-astro-cid-j7pv25f6": true },
        slots: slot(text),
      });
    const [first, second] = await Promise.all([call(" <h1 data-astro-cid-j7pv25f6>Hello, Solid!</h1> "), call(" <h1>Again</h1> ")].map(html));
    const page = finalizeIslandScripts(`${first}${second}`);
    expect(page.startsWith(
      `${BOTH_VISIBLE}${SOLID_HYDRATION}<astro-island uid="Z2aQ2Sm" data-solid-render-id="s0" component-url="/_astro/Counter.CWQ4vaRE.js" component-export="default" renderer-url="/_astro/client.elDWt4IS.js" props="{&quot;data-astro-cid-j7pv25f6&quot;:[0,true]}" ssr client="visible" opts="{&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:true}" await-children><div data-hk="s00000" class="counter"><button>-</button><pre>0</pre><button>+</button></div><div data-hk="s00001" class="counter-message"><astro-slot> <h1 data-astro-cid-j7pv25f6>Hello, Solid!</h1> </astro-slot></div><!--astro:end--></astro-island><astro-island `,
    )).toBe(true);
    expect(page.split("window._$HY").length).toBe(2);
    expect(page).toContain('data-solid-render-id="s1"');
  });

  test("with-nanostores: nested object props, and one prescript block for three load islands", async () => {
    configure(
      [renderer("@astrojs/preact", preactServer())],
      {
        [`${ROOT}/with-nanostores/src/components/CartFlyoutToggle#default`]: "/_astro/CartFlyoutToggle.COHQaOEL.js",
        [`${ROOT}/with-nanostores/src/components/AddToCartForm#default`]: "/_astro/AddToCartForm.BYAiCVZ9.js",
        [`${ROOT}/with-nanostores/src/components/CartFlyout#default`]: "/_astro/CartFlyout.ClTXWgIb.js",
      },
      { "@astrojs/preact": "/_astro/client.BL8ZRjFe.js" },
    );
    const dir = `${ROOT}/with-nanostores/src/components`;
    const result = {};
    const islands = [
      offer({
        result,
        displayName: "CartFlyoutToggle",
        Component: component("preact", "CartFlyoutToggle", () => "<button>Cart</button>"),
        props: { ...hydrated("load", `${dir}/CartFlyoutToggle`), "data-astro-cid-sckkx6r4": true },
      }),
      offer({
        result,
        displayName: "AddToCartForm",
        Component: component("preact", "AddToCartForm", (s) => `<form>${s}</form>`),
        props: {
          item: { id: "astronaut-figurine", name: "Astronaut Figurine", imageSrc: "/images/astronaut-figurine.png" },
          ...hydrated("load", `${dir}/AddToCartForm`),
          "data-astro-cid-j7pv25f6": true,
        },
        slots: slot(' <button type="submit" data-astro-cid-j7pv25f6>Add to cart</button> '),
      }),
      offer({
        result,
        displayName: "CartFlyout",
        Component: component("preact", "CartFlyout", () => '<aside hidden class="_container_jwp5b_1"><p>Your cart is empty!</p></aside>'),
        props: { ...hydrated("load", `${dir}/CartFlyout`), "data-astro-cid-sckkx6r4": true },
      }),
    ];
    const [toggle, form, flyout] = await Promise.all(islands.map(html));
    expect(finalizeIslandScripts(`${toggle} </nav> … ${form} … ${flyout}`)).toBe(
      `${BOTH_LOAD}<astro-island uid="1L2LBT" component-url="/_astro/CartFlyoutToggle.COHQaOEL.js" component-export="default" renderer-url="/_astro/client.BL8ZRjFe.js" props="{&quot;data-astro-cid-sckkx6r4&quot;:[0,true]}" ssr client="load" opts="{&quot;name&quot;:&quot;CartFlyoutToggle&quot;,&quot;value&quot;:true}" await-children><button>Cart</button><!--astro:end--></astro-island> </nav> … ` +
        `<astro-island uid="ZnNfHi" component-url="/_astro/AddToCartForm.BYAiCVZ9.js" component-export="default" renderer-url="/_astro/client.BL8ZRjFe.js" props="{&quot;item&quot;:[0,{&quot;id&quot;:[0,&quot;astronaut-figurine&quot;],&quot;name&quot;:[0,&quot;Astronaut Figurine&quot;],&quot;imageSrc&quot;:[0,&quot;/images/astronaut-figurine.png&quot;]}],&quot;data-astro-cid-j7pv25f6&quot;:[0,true]}" ssr client="load" opts="{&quot;name&quot;:&quot;AddToCartForm&quot;,&quot;value&quot;:true}" await-children><form><astro-slot> <button type="submit" data-astro-cid-j7pv25f6>Add to cart</button> </astro-slot></form><!--astro:end--></astro-island> … ` +
        `<astro-island uid="Z1pEzqe" component-url="/_astro/CartFlyout.ClTXWgIb.js" component-export="default" renderer-url="/_astro/client.BL8ZRjFe.js" props="{&quot;data-astro-cid-sckkx6r4&quot;:[0,true]}" ssr client="load" opts="{&quot;name&quot;:&quot;CartFlyout&quot;,&quot;value&quot;:true}" await-children><aside hidden class="_container_jwp5b_1"><p>Your cart is empty!</p></aside><!--astro:end--></astro-island>`,
    );
  });

  test("with-mdx: JSX children are the default slot, and MDX content hoists its prescripts to its start", async () => {
    configure(
      [renderer("@astrojs/preact", preactServer())],
      { [`${ROOT}/with-mdx/src/components/Counter.jsx#default`]: "/_astro/Counter.Cx_KsD2I.js" },
      { "@astrojs/preact": "/_astro/client.CgapTuwn.js" },
    );
    const Counter = component("preact", "Counter", (s) => `${COUNTER}<div class="counter-message">${s}</div>`);
    const island = await html(
      offer({
        source: "jsx",
        result: {},
        displayName: "Counter",
        Component: Counter,
        props: {
          ...hydrated("idle", `${ROOT}/with-mdx/src/components/Counter.jsx`),
          children: ["This is a ", createHtml("<strong>counter</strong>"), "!"],
        },
      }),
    );
    const content = `<meta charset="utf-8"/>\n\n<h1 data-astro-cid-zfufvvig>Hello world!</h1> \n<p>Written by: Jane and John.</p>\n<p>Published on: February 1, 2022.</p>\n${island}\n<h2 id="syntax-highlighting">`;
    expect(finalizeIslandScripts(hoistIslandScripts(content))).toBe(
      `${STYLE}<script>${IDLE}</script><script>${ISLAND_SCRIPT}</script><meta charset="utf-8"/>\n\n<h1 data-astro-cid-zfufvvig>Hello world!</h1> \n<p>Written by: Jane and John.</p>\n<p>Published on: February 1, 2022.</p>\n<astro-island uid="CK1BW" component-url="/_astro/Counter.Cx_KsD2I.js" component-export="default" renderer-url="/_astro/client.CgapTuwn.js" props="{}" ssr client="idle" opts="{&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:true}" await-children><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="counter-message"><astro-slot>This is a <strong>counter</strong>!</astro-slot></div><!--astro:end--></astro-island>\n<h2 id="syntax-highlighting">`,
    );
  });
});

// ── Prescript placement ───────────────────────────────────────────────────────

describe("prescripts", () => {
  const PATH = "/project/src/components/Widget";

  function preactOnly(): void {
    configure(
      [renderer("@astrojs/preact", preactServer()), renderer("@astrojs/solid-js", solidServer())],
      { [`${PATH}#default`]: "/_astro/Widget.js", [`${PATH}-solid#default`]: "/_astro/WidgetSolid.js" },
      { "@astrojs/preact": "/_astro/preact.js", "@astrojs/solid-js": "/_astro/solid.js" },
    );
  }

  const Widget = component("preact", "Widget", (s) => `<b>${s}</b>`);
  const SolidWidget = component("solid", "SolidWidget", (s, id) => `<i data-hk="${id}">${s}</i>`);

  test("a later island with a new directive gets only that directive's script", async () => {
    preactOnly();
    const result = {};
    const [first, second, third] = await Promise.all(
      [
        offer({ result, displayName: "Widget", Component: Widget, props: hydrated("visible", PATH) }),
        offer({ result, displayName: "Widget", Component: Widget, props: hydrated("load", PATH) }),
        offer({ result, displayName: "Widget", Component: Widget, props: hydrated("visible", PATH) }),
      ].map(html),
    );
    const page = finalizeIslandScripts(`${first}<hr>${second}<hr>${third}`);
    const [a, b, c] = page.split("<hr>");
    expect(a?.startsWith(`${BOTH_VISIBLE}<astro-island `)).toBe(true);
    expect(b?.startsWith(`<script>${LOAD}</script><astro-island `)).toBe(true);
    expect(c?.startsWith("<astro-island ")).toBe(true);
  });

  test("decided in document order, not in the order islands finish rendering", async () => {
    preactOnly();
    const result = {};
    const slowFirst = offer({
      result,
      displayName: "Widget",
      Component: Widget,
      props: hydrated("load", PATH),
      slots: { default: async () => { await ticks(20); return createHtml("slow"); } },
    });
    const fastSecond = offer({ result, displayName: "Widget", Component: Widget, props: hydrated("visible", PATH) });
    const second = await html(fastSecond);
    const first = await html(slowFirst);
    const page = finalizeIslandScripts(`${first}<hr>${second}`);
    expect(page.startsWith(`${BOTH_LOAD}<astro-island `)).toBe(true);
    expect(page.split("<hr>")[1]?.startsWith(`<script>${VISIBLE}</script><astro-island `)).toBe(true);
  });

  test("a Solid island after a Preact one gets Solid's script alone", async () => {
    preactOnly();
    const result = {};
    const [preact, solid] = await Promise.all(
      [
        offer({ result, displayName: "Widget", Component: Widget, props: hydrated("visible", PATH) }),
        offer({ result, displayName: "SolidWidget", Component: SolidWidget, props: hydrated("visible", `${PATH}-solid`) }),
      ].map(html),
    );
    const [a, b] = finalizeIslandScripts(`${preact}<hr>${solid}`).split("<hr>");
    expect(a?.startsWith(`${BOTH_VISIBLE}<astro-island `)).toBe(true);
    expect(b?.startsWith(`${SOLID_HYDRATION}<astro-island `)).toBe(true);
  });

  test("a client:only island takes no renderer hydration script", async () => {
    preactOnly();
    const out = finalizeIslandScripts(
      await html(offer({ result: {}, displayName: "SolidWidget", Component: null, props: hydrated("only", `${PATH}-solid`, "default", "solid") })),
    );
    expect(out.startsWith(`${STYLE}<script>/*only*/</script><script>${ISLAND_SCRIPT}</script><astro-island `)).toBe(true);
    expect(out).not.toContain("_$HY");
  });

  test("each page starts over: the state is the written page, and renderer ids key on the call's result", async () => {
    configure(
      [renderer("@astrojs/react", reactServer())],
      { [`${PATH}#default`]: "/_astro/Widget.js" },
      { "@astrojs/react": "/_astro/react.js" },
    );
    const ReactWidget = component("react", "Widget", (s) => `<b>${s}</b>`);
    for (const result of [{}, {}]) {
      const page = finalizeIslandScripts(
        await html(offer({ result, displayName: "Widget", Component: ReactWidget, props: hydrated("visible", PATH) })),
      );
      expect(page.startsWith(`${BOTH_VISIBLE}<astro-island `)).toBe(true);
      expect(page).toContain('prefix="r1"');
    }
  });

  test("an island inside another's slot has its prescripts written ahead of the outer island", async () => {
    preactOnly();
    const result = {};
    const out = await html(
      offer({
        result,
        displayName: "Widget",
        Component: Widget,
        props: hydrated("visible", PATH),
        slots: {
          default: () =>
            renderFrameworkComponent({
              source: "astro",
              result,
              displayName: "Widget",
              Component: Widget,
              props: hydrated("load", PATH),
              slots: {},
            }),
        },
      }),
    );
    const page = finalizeIslandScripts(out);
    expect(page.startsWith(`${BOTH_LOAD}<script>${VISIBLE}</script><astro-island `)).toBe(true);
    expect(page).toContain('client="visible"');
    expect(page).toContain('<b><astro-slot><astro-island uid="');
  });

  test("finalize keeps the first of each prescript, strips the sentinels, and is idempotent", () => {
    const once = finalizeIslandScripts("<p>no islands</p>");
    expect(once).toBe("<p>no islands</p>");
    expect(finalizeIslandScripts(finalizeIslandScripts(once))).toBe(once);
  });
});

// ── Renderer choice ───────────────────────────────────────────────────────────

describe("renderer choice", () => {
  const PATH = "/project/src/components/Widget";
  const Widget = component("preact", "Widget", (s) => `<b>${s}</b>`);

  function preactConfig(calls: string[] = []): void {
    configure(
      [renderer("@astrojs/preact", preactServer(calls))],
      { [`${PATH}#default`]: "/_astro/Widget.js", [`${PATH}.vue#default`]: "/_astro/WidgetVue.js" },
      { "@astrojs/preact": "/_astro/preact.js" },
    );
  }

  test("stays off until configured", () => {
    expect(renderFrameworkComponent({ source: "astro", result: {}, displayName: "X", Component: Widget, props: {}, slots: {} })).toBeNull();
  });

  test("an unclaimed static component resolves to null for pletivo to render", async () => {
    preactConfig();
    const pletivoComponent = () => createHtml("<p>pletivo</p>");
    expect(await offer({ result: {}, displayName: "P", Component: pletivoComponent, props: { a: 1 } })).toBeNull();
    expect(await offer({ result: {}, displayName: "Missing", Component: undefined, props: {} })).toBeNull();
  });

  test("a hydrated component no renderer claims throws, naming the component and the directive", async () => {
    preactConfig();
    const pletivoComponent = () => createHtml("<p>pletivo</p>");
    await expect(
      offer({ result: {}, displayName: "Clock", Component: pletivoComponent, props: hydrated("visible", "/project/src/Clock.vue") }),
    ).rejects.toThrow("Unable to render `Clock` with `client:visible`.");
    configure([renderer("@astrojs/preact", preactServer()), renderer("@astrojs/react", reactServer())], {}, {});
    await expect(offer({ result: {}, displayName: "Clock", Component: pletivoComponent, props: hydrated("load", PATH) })).rejects.toThrow(
      "Unable to render Clock with `client:load`!",
    );
  });

  test("when every check fails, the one likely renderer renders anyway, surfacing its error", async () => {
    preactConfig();
    const pletivoComponent = () => createHtml("<p>pletivo</p>");
    await expect(offer({ result: {}, displayName: "Clock", Component: pletivoComponent, props: hydrated("visible", PATH) })).rejects.toThrow(
      "not a Preact component",
    );
  });

  test("a hydrated undefined component throws Astro's import hint", async () => {
    preactConfig();
    await expect(offer({ result: {}, displayName: "Gone", Component: undefined, props: hydrated("load", PATH) })).rejects.toThrow(
      "Unable to render Gone because it is undefined!",
    );
  });

  test("a static claimed component renders without an island and drops its static slot tags", async () => {
    preactConfig();
    const out = await html(offer({ result: {}, displayName: "Widget", Component: Widget, props: {}, slots: slot("<i>x</i>") }));
    expect(out).toBe("<b><i>x</i></b>");
  });

  test("client:only skips the server render, picks the renderer by its hint, and ships slots as templates", async () => {
    const calls: string[] = [];
    preactConfig(calls);
    const out = await html(
      offer({
        result: {},
        displayName: "Widget",
        Component: null,
        props: hydrated("only", `${PATH}.vue`, "default", "preact"),
        slots: { default: () => createHtml("<p>x</p>"), fallback: () => createHtml("<i>loading</i>") },
      }),
    );
    expect(calls).toEqual([]);
    expect(finalizeIslandScripts(out)).toBe(
      `${STYLE}<script>/*only*/</script><script>${ISLAND_SCRIPT}</script><astro-island uid="1LGKSM" component-url="/_astro/WidgetVue.js" component-export="default" renderer-url="/_astro/preact.js" props="{}" ssr client="only" opts="{&quot;name&quot;:&quot;Widget&quot;,&quot;value&quot;:&quot;preact&quot;}" await-children><i>loading</i><template data-astro-template><p>x</p></template><template data-astro-template="fallback"><i>loading</i></template><!--astro:end--></astro-island>`,
    );
  });

  test("MDX's client:only: named by client:display-name, no check on the component it passes", async () => {
    const calls: string[] = [];
    preactConfig(calls);
    const out = await html(
      offer({
        source: "jsx",
        result: {},
        displayName: "Widget",
        Component: Widget,
        props: {
          "client:only": "preact",
          "client:component-path": PATH,
          "client:component-export": "default",
          "client:display-name": "Counter",
          "client:component-hydration": true,
          children: "hi",
        },
      }),
    );
    expect(calls).toEqual([]);
    expect(finalizeIslandScripts(out)).toBe(
      `${STYLE}<script>/*only*/</script><script>${ISLAND_SCRIPT}</script><astro-island uid="Z169HCW" component-url="/_astro/Widget.js" component-export="default" renderer-url="/_astro/preact.js" props="{}" ssr client="only" opts="{&quot;name&quot;:&quot;Counter&quot;,&quot;value&quot;:&quot;preact&quot;}" await-children><template data-astro-template>hi</template><!--astro:end--></astro-island>`,
    );
  });

  test("client:only without a renderer to match throws Astro's hint error", async () => {
    configure(
      [renderer("@astrojs/preact", preactServer()), renderer("@astrojs/react", reactServer())],
      {},
      {},
    );
    await expect(offer({ result: {}, displayName: "W", Component: null, props: hydrated("only", PATH, "default", true) })).rejects.toThrow(
      "Astro needs a hint to use the correct renderer",
    );
  });

  test("rejects an unknown directive and client:media without a query", async () => {
    preactConfig();
    await expect(offer({ result: {}, displayName: "W", Component: Widget, props: { "client:hover": true } })).rejects.toThrow(
      'invalid hydration directive "client:hover"',
    );
    await expect(offer({ result: {}, displayName: "W", Component: Widget, props: hydrated("media", PATH) })).rejects.toThrow(
      "Media query not provided for `client:media` directive",
    );
  });

  test("React's check deletes class from the serialized props, even for a component another renderer claims", async () => {
    configure(
      [renderer("@astrojs/react", reactServer()), renderer("@astrojs/preact", preactServer())],
      { [`${PATH}#default`]: "/_astro/Widget.js" },
      { "@astrojs/react": "/_astro/react.js", "@astrojs/preact": "/_astro/preact.js" },
    );
    const ReactWidget = component("react", "Widget", () => "<b></b>");
    for (const Component of [ReactWidget, Widget]) {
      const out = await html(
        offer({ result: {}, displayName: "Widget", Component, props: { class: "big", n: 1, ...hydrated("load", PATH) } }),
      );
      expect(out).toContain('props="{&quot;n&quot;:[0,1]}"');
    }
  });

  test("class:list folds into class before the props are serialized", async () => {
    preactConfig();
    const out = await html(
      offer({
        result: {},
        displayName: "Widget",
        Component: Widget,
        props: { class: "x", "class:list": ["a", { b: true, c: false }], ...hydrated("load", PATH) },
      }),
    );
    expect(out).toContain('props="{&quot;class&quot;:[0,&quot;x a b&quot;]}"');
  });

  test("the renderer gets the directive-free props, Astro's metadata and the page result", async () => {
    const seen: { props: Record<string, unknown>; metadata: RendererMetadata | undefined; result: object }[] = [];
    const recording: RendererServer = {
      check: () => true,
      renderToStaticMarkup(_Component, props, _slots, metadata) {
        seen.push({ props, metadata, result: this.result });
        return { html: "<b></b>" };
      },
    };
    configure([renderer("recording", recording)], { [`${PATH}#default`]: "/_astro/Widget.js" }, { recording: "/_astro/r.js" });
    const result = {};
    const out = await html(
      offer({
        result,
        displayName: "Widget",
        Component: Widget,
        props: { a: 1, ...hydrated("visible", PATH), "data-astro-transition-scope": "s1" },
      }),
    );
    expect(seen).toEqual([
      {
        props: { a: 1 },
        metadata: {
          astroStaticSlot: true,
          displayName: "Widget",
          hydrate: "visible",
          hydrateArgs: true,
          componentExport: { value: "default" },
          componentUrl: PATH,
        },
        result,
      },
    ]);
    expect(out).toContain(
      'props="{&quot;a&quot;:[0,1],&quot;data-astro-transition-scope&quot;:[0,&quot;s1&quot;]}" ssr client="visible" opts="{&quot;name&quot;:&quot;Widget&quot;,&quot;value&quot;:true}" data-astro-transition-scope="s1" await-children>',
    );
  });

  test("a slot the renderer leaves out travels as a template; values are escaped as Astro escapes them", async () => {
    const slotless: RendererServer = {
      check: () => true,
      renderToStaticMarkup: () => ({ html: "<b></b>", attrs: { "data-x": `a"<'&` } }),
    };
    configure([renderer("slotless", slotless)], { [`${PATH}#default`]: "/_astro/Widget.js" }, { slotless: "/_astro/s.js" }, "/_astro/before.js");
    const out = await html(
      offer({
        result: {},
        displayName: "W<'&\"",
        Component: Widget,
        props: { s: `<'&">`, ...hydrated("media", PATH, "default", "(min-width: 1px)") },
        slots: { default: () => createHtml("<p>d</p>"), extra: () => createHtml("<p>e</p>") },
      }),
    );
    expect(out).toContain(
      ' data-x="a&quot;&lt;&#39;&amp;" component-url="/_astro/Widget.js" component-export="default" renderer-url="/_astro/s.js" props="{&quot;s&quot;:[0,&quot;&lt;&#39;&amp;\\&quot;&gt;&quot;]}" ssr client="media" before-hydration-url="/_astro/before.js" opts="{&quot;name&quot;:&quot;W&lt;&#39;&amp;\\&quot;&quot;,&quot;value&quot;:&quot;(min-width: 1px)&quot;}" await-children><b></b><template data-astro-template><p>d</p></template><template data-astro-template="extra"><p>e</p></template><!--astro:end--></astro-island>',
    );
  });

  test("an empty slot is still a slot: StaticHtml emits <astro-slot> and no template follows", async () => {
    preactConfig();
    const out = await html(
      offer({ result: {}, displayName: "Widget", Component: Widget, props: hydrated("visible", PATH), slots: slot("") }),
    );
    expect(out).toContain("<b><astro-slot></astro-slot></b><!--astro:end--></astro-island>");
    expect(out).not.toContain("data-astro-template");
  });

  test("a non-string renderer attr is written as its string, as React's data-react-children is", async () => {
    const childrenAttr: RendererServer = {
      check: () => true,
      renderToStaticMarkup() {
        // What @astrojs/react returns with experimentalReactChildren.
        return { html: "<b></b>", attrs: { prefix: "r0", "data-react-children": true } };
      },
    };
    configure([renderer("@astrojs/react", childrenAttr)], { [`${PATH}#default`]: "/_astro/Widget.js" }, { "@astrojs/react": "/_astro/r.js" });
    const out = await html(offer({ result: {}, displayName: "Widget", Component: Widget, props: hydrated("load", PATH) }));
    expect(out).toContain(' prefix="r0" data-react-children="true" component-url="/_astro/Widget.js"');
  });

  test("whitespace-only JSX children are no slot at all", async () => {
    const seen: RenderedSlots[] = [];
    const recording: RendererServer = {
      check: () => true,
      renderToStaticMarkup(_Component, _props, slots) {
        seen.push(slots);
        return { html: "<b></b>" };
      },
    };
    configure([renderer("recording", recording)], { [`${PATH}#default`]: "/_astro/Widget.js" }, { recording: "/_astro/r.js" });
    const out = await html(
      offer({ source: "jsx", result: {}, displayName: "Widget", Component: Widget, props: { ...hydrated("load", PATH), children: [" \n", "  "] } }),
    );
    expect(seen).toEqual([{}]);
    expect(out).toContain("<b></b><!--astro:end--></astro-island>");
  });

  test("a component tagged with Astro's renderer symbol skips every check", async () => {
    const checked: string[] = [];
    const named = (name: string, claims: boolean): LoadedRenderer =>
      renderer(name, {
        check() {
          checked.push(name);
          return claims;
        },
        renderToStaticMarkup: () => ({ html: `<b>${name}</b>` }),
      });
    configure(
      [named("first", true), named("tagged", false)],
      { [`${PATH}#default`]: "/_astro/Widget.js" },
      { first: "/_astro/first.js", tagged: "/_astro/tagged.js" },
    );
    const Tagged = () => null;
    Object.defineProperty(Tagged, Symbol.for("astro:renderer"), { value: "tagged" });
    const out = await html(offer({ result: {}, displayName: "Tagged", Component: Tagged, props: hydrated("load", PATH) }));
    expect(checked).toEqual([]);
    expect(out).toContain('renderer-url="/_astro/tagged.js"');
    expect(out).toContain("<b>tagged</b>");
  });

  test("an empty before-hydration URL is omitted, as Astro omits an empty one", async () => {
    configure(
      [renderer("@astrojs/preact", preactServer())],
      { [`${PATH}#default`]: "/_astro/Widget.js" },
      { "@astrojs/preact": "/_astro/preact.js" },
      "",
    );
    const out = await html(offer({ result: {}, displayName: "Widget", Component: Widget, props: hydrated("load", PATH) }));
    expect(out).toContain('ssr client="load" opts=');
    expect(out).not.toContain("before-hydration-url");
  });

  test("client:only drops the prescripts of its second fallback render; the first render's lead the island", async () => {
    preactConfig();
    const result = {};
    const fallback = () =>
      renderFrameworkComponent({ source: "astro", result, displayName: "Widget", Component: Widget, props: hydrated("load", PATH), slots: {} });
    const out = await html(
      offer({ result, displayName: "Widget", Component: null, props: hydrated("only", PATH, "default", "preact"), slots: { fallback } }),
    );
    const outer = out.indexOf('client="only"');
    expect(out.slice(0, outer)).toContain("pletivo-island-prescript:directive%3Aload");
    expect(out.slice(outer)).not.toContain("pletivo-island-prescript");
  });

  test("a hydrated component without an export throws Astro's NoMatchingImport", async () => {
    configure([renderer("@astrojs/preact", preactServer())], { "#": "/_astro/Widget.js" }, { "@astrojs/preact": "/_astro/preact.js" });
    await expect(
      offer({ source: "jsx", result: {}, displayName: "Widget", Component: Widget, props: { "client:visible": true } }),
    ).rejects.toThrow("Could not render `Widget`. No matching import has been found for `Widget`.");
  });

  test("client:only takes a renderer by its hint only for Astro's known framework names", async () => {
    configure(
      [renderer("foo", preactServer()), renderer("@astrojs/react", reactServer())],
      { [`${PATH}#default`]: "/_astro/Widget.js" },
      { foo: "/_astro/foo.js", "@astrojs/react": "/_astro/react.js" },
    );
    await expect(
      offer({ result: {}, displayName: "W", Component: null, props: hydrated("only", PATH, "default", "foo") }),
    ).rejects.toThrow("Astro needs a hint to use the correct renderer");
    await expect(
      offer({ result: {}, displayName: "W", Component: null, props: hydrated("only", PATH, "default", "vue") }),
    ).rejects.toThrow("Unable to render `W` with `client:only`.");
  });
});

// ── Props serialization ───────────────────────────────────────────────────────

describe("serializeProps", () => {
  test("encodes every tuple type as Astro does", () => {
    const value = {
      str: "a\"b<c>&'",
      num: 1.5,
      bool: false,
      nil: null,
      undef: undefined,
      obj: { nested: [1, "x", { deep: true }] },
      arr: [undefined, () => 1, null],
      re: /a+b/gi,
      date: new Date("2024-01-02T03:04:05.000Z"),
      map: new Map<unknown, unknown>([["k", 1], [2, { v: true }]]),
      set: new Set(["s", 3]),
      big: 12345678901234567890n,
      url: new URL("https://example.com/a?b=1"),
      u8: new Uint8Array([1, 2]),
      u16: new Uint16Array([300]),
      u32: new Uint32Array([70000]),
      inf: Infinity,
      ninf: -Infinity,
      fn: () => 1,
    };
    // Output of astro@5.16.11's serializeProps for the same value.
    expect(serializeProps(value, { displayName: "X" })).toBe(
      '{"str":[0,"a\\"b<c>&\'"],"num":[0,1.5],"bool":[0,false],"nil":[0,null],"undef":[0],"obj":[0,{"nested":[1,[[0,1],[0,"x"],[0,{"deep":[0,true]}]]]}],"arr":[1,[[0],[0,null],[0,null]]],"re":[2,"a+b"],"date":[3,"2024-01-02T03:04:05.000Z"],"map":[4,[[1,[[0,"k"],[0,1]]],[1,[[0,2],[0,{"v":[0,true]}]]]]],"set":[5,[[0,"s"],[0,3]]],"big":[6,"12345678901234567890"],"url":[7,"https://example.com/a?b=1"],"u8":[8,[1,2]],"u16":[9,[300]],"u32":[10,[70000]],"inf":[11,1],"ninf":[11,-1],"fn":[0,null]}',
    );
  });

  test("refuses a cyclic reference", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serializeProps(cyclic, { displayName: "C", hydrate: "load" })).toThrow(
      "Cyclic reference detected while serializing props for <C client:load>!",
    );
  });
});
