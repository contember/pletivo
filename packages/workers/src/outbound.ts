/**
 * What the render isolate may reach over the network — and why that is a union
 * rather than an optional stub.
 *
 * The Worker Loader decides this with one field, `globalOutbound`, and its default is
 * a trap. Set to `null` the isolate is cut off: `fetch()` and `connect()` throw. Set
 * to a service binding, every outbound request goes through that binding instead —
 * including a loopback one from `ctx.exports`, which is where filtering, logging and
 * allow-listing live. **Omitted, it inherits the host worker's own network access**,
 * which on a deployed Worker is the public Internet.
 *
 * A render isolate runs JavaScript the host generated a millisecond ago out of
 * somebody's sources. Inheriting the Internet is the last thing it should do by
 * accident, so this module makes each of the three states a thing you have to name:
 *
 * ```ts
 * renderPage({ ... })                                            // cut off
 * renderPage({ ..., outbound: { kind: "blocked" } })             // cut off, said out loud
 * renderPage({ ..., outbound: { kind: "proxy", binding } })      // only what `binding` allows
 * renderPage({ ..., outbound: { kind: "inherit" } })             // whatever the host can reach
 * ```
 *
 * There is no value of the option that reaches the Internet without the word
 * `inherit` in it. Omitting the option, passing `undefined`, or passing a binding
 * without saying `kind: "proxy"` all end at `globalOutbound: null` — the last of
 * those does not type-check at all, and an unknown `kind` arriving from JavaScript
 * falls to the same place. The failure direction is always *less* access.
 */

/**
 * A fetcher the isolate's outbound requests go through.
 *
 * Declared structurally rather than as `Fetcher` from `@cloudflare/workers-types`, the
 * same way `WorkerLoaderBinding` and `ContentBinding` are: whatever the host app has
 * — a loopback `WorkerEntrypoint` from `ctx.exports`, a service binding to another
 * Worker, a Durable Object stub — has to satisfy this and nothing more.
 */
export interface OutboundBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * The three things a caller can mean, spelled out.
 *
 *  - `blocked` — `globalOutbound: null`. `fetch()` inside the isolate throws. The
 *    default, and what every render that is a pure function of its sources wants.
 *  - `proxy` — every outbound request is delivered to `binding` instead of to the
 *    network. The binding decides what exists: it can answer from memory, forward a
 *    permitted origin and refuse the rest, or record what was asked for. Nothing
 *    reaches the Internet unless the binding itself goes there.
 *  - `inherit` — the field is omitted and the isolate gets whatever the host worker
 *    can reach, which in production means the public Internet, unfiltered. Only
 *    reachable by typing the word.
 */
export type OutboundAccess =
  | { readonly kind: "blocked" }
  | { readonly kind: "proxy"; readonly binding: OutboundBinding }
  | { readonly kind: "inherit" };

/** Names the configuration, for the isolate cache key. See `isolateId` in render.ts. */
export function outboundKind(access: OutboundAccess | undefined): OutboundAccess["kind"] {
  return access === undefined ? "blocked" : access.kind;
}

/**
 * The `globalOutbound` part of a dynamic Worker's code, as an object to spread.
 *
 * A fragment rather than a value because the three states are *present and null*,
 * *present and a stub*, and *absent* — and the third one is the only way to say
 * "inherit". `default` rather than `case "blocked"` on purpose: a `kind` this package
 * has never heard of, or one from a JavaScript caller with no types at all, lands on
 * the cut-off branch instead of falling through to the inheriting one.
 */
export function outboundConfig(access: OutboundAccess | undefined): {
  globalOutbound?: OutboundBinding | null;
} {
  if (access === undefined) return { globalOutbound: null };
  switch (access.kind) {
    case "proxy":
      return { globalOutbound: access.binding };
    case "inherit":
      return {};
    default:
      return { globalOutbound: null };
  }
}
