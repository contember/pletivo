/**
 * Client-side island runtime.
 * Provides DOM-based JSX, reactive useState, and island mounting.
 * This module replaces the server JSX runtime and hooks during island bundling.
 */

// --- Component instance tracking ---

interface ComponentInstance {
  hooks: unknown[];
  element: HTMLElement;
  component: (props: Record<string, unknown>) => Node;
  props: Record<string, unknown>;
  vnode: Node | null;
}

let currentInstance: ComponentInstance | null = null;
let hookIdx = 0;
let pendingRerender: Set<ComponentInstance> = new Set();
let rerenderScheduled = false;

// --- Hooks ---

export function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const inst = currentInstance;
  if (!inst) {
    // Fallback for non-component context (shouldn't happen on client)
    const value = typeof initial === "function" ? (initial as () => T)() : initial;
    return [value, () => {}];
  }

  const idx = hookIdx++;

  if (inst.hooks.length <= idx) {
    inst.hooks.push(typeof initial === "function" ? (initial as () => T)() : initial);
  }

  const setState = (value: T | ((prev: T) => T)) => {
    const newVal = typeof value === "function"
      ? (value as (prev: T) => T)(inst.hooks[idx] as T)
      : value;
    if (newVal !== inst.hooks[idx]) {
      inst.hooks[idx] = newVal;
      pendingRerender.add(inst);
      if (!rerenderScheduled) {
        rerenderScheduled = true;
        queueMicrotask(flushRerenders);
      }
    }
  };

  return [inst.hooks[idx] as T, setState];
}

function flushRerenders() {
  rerenderScheduled = false;
  const batch = pendingRerender;
  pendingRerender = new Set();

  for (const inst of batch) {
    currentInstance = inst;
    hookIdx = 0;
    const newNode = inst.component(inst.props);
    currentInstance = null;

    if (inst.vnode && inst.vnode.parentNode) {
      inst.vnode.parentNode.replaceChild(newNode, inst.vnode);
    } else {
      inst.element.textContent = "";
      inst.element.appendChild(newNode);
    }
    inst.vnode = newNode;
  }
}

// --- DOM JSX Runtime ---

function appendChildren(parent: HTMLElement | DocumentFragment, children: unknown): void {
  if (children == null || children === false || children === true) return;

  if (typeof children === "string" || typeof children === "number") {
    parent.appendChild(document.createTextNode(String(children)));
    return;
  }

  if (Array.isArray(children)) {
    for (const child of children) {
      appendChildren(parent, child);
    }
    return;
  }

  if (children instanceof Node) {
    parent.appendChild(children);
  }
}

export function jsx(
  tag: string | ((props: Record<string, unknown>) => Node),
  props: Record<string, unknown>,
): Node {
  if (typeof tag === "function") {
    return tag(props);
  }

  const el = document.createElement(tag);
  const { children, ...attrs } = props;

  for (const [key, value] of Object.entries(attrs)) {
    if (key === "key" || key === "ref") continue;
    if (value == null || value === false) continue;

    if (key === "dangerouslySetInnerHTML") {
      el.innerHTML = (value as { __html: string }).__html;
      continue;
    }

    // Event handlers
    if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
      const event = key[2].toLowerCase() + key.slice(3);
      el.addEventListener(event, value as EventListener);
      continue;
    }

    if (key === "className") {
      el.className = String(value);
      continue;
    }

    if (key === "htmlFor") {
      el.setAttribute("for", String(value));
      continue;
    }

    if (key === "style" && typeof value === "object") {
      Object.assign(el.style, value);
      continue;
    }

    if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }

  if (!("dangerouslySetInnerHTML" in attrs)) {
    appendChildren(el, children);
  }

  return el;
}

export { jsx as jsxs, jsx as jsxDEV };

export function Fragment(props: { children?: unknown }): DocumentFragment {
  const frag = document.createDocumentFragment();
  appendChildren(frag, props.children);
  return frag;
}

// --- Island Mount ---

export function mountIsland(
  Component: (props: Record<string, unknown>) => Node,
  element: HTMLElement,
  props: Record<string, unknown>,
): void {
  const inst: ComponentInstance = {
    hooks: [],
    element,
    component: Component,
    props,
    vnode: null,
  };

  currentInstance = inst;
  hookIdx = 0;
  const node = Component(props);
  currentInstance = null;

  // Replace SSR content with client-rendered DOM
  element.textContent = "";
  element.appendChild(node);
  inst.vnode = node;
}
