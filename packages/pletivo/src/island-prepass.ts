// PROBE: hydrated components as the compilers report them, per compiled file, before any render.
export interface StaticIsland {
  componentPath: string;
  exportName: string;
}

const byFile = new Map<string, StaticIsland[]>();

export function recordStaticIslands(file: string, islands: StaticIsland[]): void {
  byFile.set(file, islands);
}

export function addStaticIsland(file: string, island: StaticIsland): void {
  const list = byFile.get(file) ?? [];
  list.push(island);
  byFile.set(file, list);
}

export function staticIslands(): StaticIsland[] {
  const out = new Map<string, StaticIsland>();
  for (const list of byFile.values()) {
    for (const island of list) out.set(`${island.componentPath}\0${island.exportName}`, island);
  }
  return [...out.values()];
}

export function staticIslandFiles(): ReadonlyMap<string, StaticIsland[]> {
  return byFile;
}
