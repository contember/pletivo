/**
 * A project path with separators and dot segments normalized, as a file-map key.
 * Its own module because the isolate entry bundles it too.
 */
export function normalizeProjectPath(path: string): string {
  const normalized: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/");
}
