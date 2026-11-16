import { getEntry, render } from "../../../../packages/pletivo/src/content/collection";

// A .tsx page renders the same MDX entry: its .astro component joins this page's request.
export default async function Page() {
  const entry = await getEntry("docs", "intro");
  const { Content } = await render(entry);
  const body = await Content();
  return (
    <html>
      <body>{body}</body>
    </html>
  );
}
