/**
 * Island props as Astro serializes them (`runtime/server/serialize.ts`): every value a
 * `[type, value]` tuple that `astro-island`'s client revives. The tuple numbers are the
 * client protocol, so they must not change.
 */
const PROP_TYPE = {
  Value: 0,
  JSON: 1, // an Array
  RegExp: 2,
  Date: 3,
  Map: 4,
  Set: 5,
  BigInt: 6,
  URL: 7,
  Uint8Array: 8,
  Uint16Array: 9,
  Uint32Array: 10,
  Infinity: 11,
} as const;

/** What the cyclic-reference error names. */
export interface SerializeContext {
  displayName?: string;
  hydrate?: string;
}

function cyclicError(context: SerializeContext): Error {
  return new Error(`Cyclic reference detected while serializing props for <${context.displayName} client:${context.hydrate}>!

Cyclic references cannot be safely serialized for client-side usage. Please remove the cyclic reference.`);
}

function serializeArray(value: readonly unknown[], context: SerializeContext, parents: WeakSet<object>): unknown[] {
  if (parents.has(value)) throw cyclicError(context);
  parents.add(value);
  const serialized = value.map((item) => convertToSerializedForm(item, context, parents));
  parents.delete(value);
  return serialized;
}

function serializeObject(value: object, context: SerializeContext, parents: WeakSet<object>): Record<string, unknown> {
  if (parents.has(value)) throw cyclicError(context);
  parents.add(value);
  const serialized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, convertToSerializedForm(item, context, parents)]),
  );
  parents.delete(value);
  return serialized;
}

function convertToSerializedForm(value: unknown, context: SerializeContext, parents: WeakSet<object>): unknown[] {
  if (value instanceof Date) return [PROP_TYPE.Date, value.toISOString()];
  if (value instanceof RegExp) return [PROP_TYPE.RegExp, value.source];
  if (value instanceof Map) return [PROP_TYPE.Map, serializeArray(Array.from(value), context, parents)];
  if (value instanceof Set) return [PROP_TYPE.Set, serializeArray(Array.from(value), context, parents)];
  if (typeof value === "bigint") return [PROP_TYPE.BigInt, value.toString()];
  if (value instanceof URL) return [PROP_TYPE.URL, value.toString()];
  if (Array.isArray(value)) return [PROP_TYPE.JSON, serializeArray(value, context, parents)];
  if (value instanceof Uint8Array) return [PROP_TYPE.Uint8Array, Array.from(value)];
  if (value instanceof Uint16Array) return [PROP_TYPE.Uint16Array, Array.from(value)];
  if (value instanceof Uint32Array) return [PROP_TYPE.Uint32Array, Array.from(value)];
  if (value !== null && typeof value === "object") return [PROP_TYPE.Value, serializeObject(value, context, parents)];
  if (value === Infinity) return [PROP_TYPE.Infinity, 1];
  if (value === -Infinity) return [PROP_TYPE.Infinity, -1];
  if (value === undefined) return [PROP_TYPE.Value];
  return [PROP_TYPE.Value, value];
}

export function serializeProps(props: object, context: SerializeContext): string {
  return JSON.stringify(serializeObject(props, context, new WeakSet()));
}
