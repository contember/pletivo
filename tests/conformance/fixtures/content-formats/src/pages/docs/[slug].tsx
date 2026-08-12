import {
  getCollection,
  type CollectionEntry,
} from "../../../../../../../packages/pletivo/src/content/collection";

export async function getStaticPaths() {
  const docs = await getCollection("docs");
  return await Promise.all(
    docs.map(async (doc) => {
      // Both .md and .mdx entries go through the same render() surface — the
      // .mdx one takes the compiled-module path, the .md one the remark path.
      const { html } = await doc.render();
      return { params: { slug: doc.id }, props: { doc, html } };
    }),
  );
}

export default function Doc(props: { doc: CollectionEntry; html: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{props.doc.data.title as string}</title>
      </head>
      <body>
        <article dangerouslySetInnerHTML={{ __html: props.html }} />
      </body>
    </html>
  );
}
