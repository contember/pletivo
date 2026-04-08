import { getCollection } from "../../../../../packages/pavouk/src/content/collection";
import type { CollectionEntry } from "../../../../../packages/pavouk/src/content/collection";
import Layout from "../../components/Layout";

export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return await Promise.all(
    posts.map(async (post) => {
      const { html } = await post.render();
      return {
        params: { slug: post.id },
        props: { post, html },
      };
    }),
  );
}

export default function BlogPost(props: { post: CollectionEntry; html: string }) {
  const { post, html } = props;
  return (
    <Layout title={post.data.title as string}>
      <article>
        <h1>{post.data.title as string}</h1>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </Layout>
  );
}
