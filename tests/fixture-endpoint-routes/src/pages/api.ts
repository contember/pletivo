/** Extensionless endpoint: Astro emits it as a file named `api`. */
export function GET() {
  return new Response(JSON.stringify({ foo: "bar" }), {
    headers: { "Content-Type": "application/json" },
  });
}
