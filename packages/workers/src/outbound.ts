/**
 * What the render isolate may reach over the network. An omitted `globalOutbound`
 * inherits the host's network, so that state is reachable only by naming `inherit`;
 * every other input, including an unknown `kind`, ends at `globalOutbound: null`.
 */

/** A fetcher the isolate's outbound requests go through. Structural, like `ContentBinding`. */
export interface OutboundBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * - `blocked` (default): `fetch()` inside the isolate throws.
 * - `proxy`: every outbound request goes to `binding` instead of the network.
 * - `inherit`: the isolate gets whatever the host worker can reach, unfiltered.
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
 * The `globalOutbound` part of a dynamic Worker's code, as an object to spread: absence
 * is the only way to say "inherit". `default`, not `case "blocked"`, so an unknown
 * `kind` from an untyped caller lands on the cut-off branch.
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
