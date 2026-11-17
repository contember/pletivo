export async function load(): Promise<string> {
  await import("../components/Dyn.svelte");
  return "loaded";
}
