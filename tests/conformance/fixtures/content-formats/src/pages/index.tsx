import { getCollection } from "../../../../../../packages/pletivo/src/content/collection";

export default async function Index() {
  const docs = await getCollection("docs");
  docs.sort((a, b) => (a.data.order as number) - (b.data.order as number));
  const [site] = await getCollection("data");
  const data = site!.data as Record<string, any>;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{data.title}</title>
      </head>
      <body>
        <nav>
          {data.nav.map((item: { label: string; href: string }) => (
            <a href={item.href}>{item.label}</a>
          ))}
        </nav>
        <h1>{data.title}</h1>
        <p class="tagline">{data.tagline}</p>
        <pre class="banner">{data.banner}</pre>
        {/* YAML merge key: `staging` inherits adapter/host from the anchor. */}
        <dl class="staging">
          <dt>adapter</dt>
          <dd>{data.staging.adapter}</dd>
          <dt>host</dt>
          <dd>{data.staging.host}</dd>
          <dt>database</dt>
          <dd>{data.staging.database}</dd>
        </dl>
        <ul class="flags">
          {data.flags.map((f: string) => (
            <li>{f}</li>
          ))}
        </ul>
        <ul class="docs">
          {docs.map((doc) => (
            <li>
              <a href={`/docs/${doc.id}`}>{doc.data.title as string}</a>
              <span class="tags">{(doc.data.tags as string[]).join(", ")}</span>
            </li>
          ))}
        </ul>
      </body>
    </html>
  );
}
