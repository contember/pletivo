export async function load() {
  return (await import("../components/Dyn.svelte")).default;
}
