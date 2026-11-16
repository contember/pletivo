/** Dynamic extensionless endpoint: the build skips it, dev serves only the listed ids. */
export function getStaticPaths() {
  return [
    { params: { id: "a" }, props: { label: "Item A" } },
    { params: { id: "b" }, props: { label: "Item B" } },
  ];
}

export function GET({ params, props }: { params: { id: string }; props: { label: string } }) {
  return new Response(JSON.stringify({ id: params.id, label: props.label }), {
    headers: { "Content-Type": "application/json" },
  });
}
