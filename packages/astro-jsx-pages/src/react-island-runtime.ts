/**
 * Runtime helper for rendering Astro islands in React pages.
 * This is injected into React pages that use client: directives.
 */
import * as React from 'react';

export interface IslandConfig {
  /** Hydration strategy */
  client: 'load' | 'idle' | 'visible' | 'media' | 'only';
  /** Value for client:media or client:visible */
  clientValue?: string;
  /** Contexts to propagate during hydration */
  contexts?: Record<string, React.Context<any>>;
}

/** Symbol to mark a component as an island */
export const ISLAND_MARKER = Symbol.for('astro-jsx-pages.island');

/**
 * Marks a component as an island with automatic hydration.
 * The component will be hydrated on the client without needing client:load at usage site.
 *
 * Usage:
 * ```tsx
 * function MyComponent({ value }: Props) {
 *   const theme = useContext(ThemeContext);
 *   return <div>...</div>;
 * }
 *
 * export default asIsland(MyComponent, {
 *   client: 'load',
 *   contexts: { theme: ThemeContext },
 * });
 * ```
 */
export function asIsland<P extends Record<string, any>>(
  Component: React.ComponentType<P>,
  config: IslandConfig
): React.ComponentType<P> & { __island: IslandConfig; contexts?: Record<string, React.Context<any>> } {
  const { contexts } = config;

  const Wrapped = ({ __contexts, ...props }: P & { __contexts?: Record<string, any> }) => {
    let element: React.ReactNode = React.createElement(Component, props as P);

    // Wrap with context providers if __contexts is provided (during hydration)
    if (__contexts && contexts) {
      // Wrap in reverse order so first context is outermost
      const entries = Object.entries(contexts).reverse();
      for (const [name, Context] of entries) {
        if (name in __contexts) {
          element = React.createElement(Context.Provider, { value: __contexts[name] }, element);
        }
      }
    }

    return element as React.ReactElement;
  };

  // Attach island config for plugin to read
  (Wrapped as any).__island = config;
  (Wrapped as any)[ISLAND_MARKER] = true;
  if (contexts) {
    (Wrapped as any).contexts = contexts;
  }
  Wrapped.displayName = `asIsland(${Component.displayName || Component.name || 'Component'})`;

  return Wrapped as any;
}

// Keep withContexts as an alias for backwards compatibility
export const withContexts = <P extends Record<string, any>>(
  Component: React.ComponentType<P>,
  contexts: Record<string, React.Context<any>>
) => asIsland(Component, { client: 'load', contexts });

export interface IslandOptions {
  Component: React.ComponentType<any>;
  props: Record<string, any>;
  componentPath: string;
  componentExport: string;
  client: 'load' | 'idle' | 'visible' | 'media' | 'only';
  clientValue?: string;
  children?: React.ReactNode;
}

// Island counter for unique IDs
let islandCounter = 0;

/**
 * Reset island counter - called at the start of each page render.
 */
export function resetIslandCounter(): void {
  islandCounter = 0;
}

/**
 * Recursively encodes a value for Astro's prop serialization format.
 * All values must be wrapped as [type, encodedValue] pairs.
 * Type 0 = primitive/object, which recursively encodes nested objects.
 */
function encodeValue(value: any): [number, any] {
  if (value === null || value === undefined) {
    return [0, value];
  }

  if (Array.isArray(value)) {
    // Arrays: encode each element
    return [0, value.map(item => encodeValue(item))];
  }

  if (typeof value === 'object') {
    // Objects: encode each property value
    const encoded: Record<string, [number, any]> = {};
    for (const [key, val] of Object.entries(value)) {
      encoded[key] = encodeValue(val);
    }
    return [0, encoded];
  }

  // Primitives (string, number, boolean)
  return [0, value];
}

/**
 * Island component props - used when rendering via <Island /> component.
 */
export interface IslandProps {
  Component: React.ComponentType<any> & {
    contexts?: Record<string, React.Context<any>>;
  };
  props: Record<string, any>;
  componentPath: string;
  componentExport: string;
  client: 'load' | 'idle' | 'visible' | 'media' | 'only';
  clientValue?: string;
  children?: React.ReactNode;
}

/**
 * Island component that automatically reads declared contexts.
 * Usage: <Island Component={MyComp} props={{...}} client="load" ... />
 *
 * If Component.contexts is defined as { name: Context }, the values
 * will be automatically read and passed as __contexts prop.
 */
export function Island({
  Component,
  props,
  componentPath,
  componentExport,
  client,
  clientValue,
  children,
}: IslandProps): React.ReactElement {
  // Build final props, potentially with auto-read contexts
  let finalProps = { ...props };

  // Check if component declares contexts to auto-propagate
  if (Component.contexts && typeof Component.contexts === 'object') {
    const __contexts: Record<string, any> = {};
    for (const [name, ctx] of Object.entries(Component.contexts)) {
      // Read the current context value using useContext
      // eslint-disable-next-line react-hooks/rules-of-hooks
      __contexts[name] = React.useContext(ctx);
    }
    finalProps.__contexts = __contexts;
  }

  return createIslandInternal({
    Component,
    props: finalProps,
    componentPath,
    componentExport,
    client,
    clientValue,
    children,
  });
}

/**
 * Creates an island placeholder that will be post-processed into proper astro-island HTML.
 * The component is rendered as a child of the placeholder, so React hooks work properly.
 */
function createIslandInternal(options: IslandOptions): React.ReactElement {
  const id = islandCounter++;
  const { Component, props, componentPath, componentExport, client, clientValue, children } = options;

  // Serialize props for the client - Astro uses a special encoding format
  // All values (including nested) must be [type, value] pairs
  const serializedProps: Record<string, [number, any]> = {};
  for (const [key, value] of Object.entries(props)) {
    serializedProps[key] = encodeValue(value);
  }
  const propsJson = JSON.stringify(serializedProps);

  // For client:only, don't render the component on server
  const content = client === 'only'
    ? null
    : React.createElement(Component, props, children);

  // Return placeholder with component as child (React will SSR it properly)
  return React.createElement(
    'astro-island-placeholder',
    {
      'data-island-id': id,
      'data-client': client,
      'data-client-value': clientValue || '',
      'data-component-path': componentPath,
      'data-component-export': componentExport,
      'data-props': propsJson,
    },
    content
  );
}
