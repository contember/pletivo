import path from "node:path";

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

/** Whether a `path.relative` result stays inside the directory it is relative to. */
export function isInsideRoot(relative: string): boolean {
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
