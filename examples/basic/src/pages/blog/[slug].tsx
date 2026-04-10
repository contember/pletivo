import { getCollection } from "../../../../../packages/pletivo/src/content/collection";
import type { CollectionEntry } from "../../../../../packages/pletivo/src/content/collection";
import Layout from "../../components/Layout";
import PostDetail from "../../components/PostDetail";

export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return await Promise.all(
    posts.map(async (post) => {
      const { html } = await post.render();
      const tags = (post.data.tags as string[] | undefined) ?? [];
      const related = posts
        .filter(
          (p) =>
            p.id !== post.id &&
            ((p.data.tags as string[] | undefined) ?? []).some((t) => tags.includes(t)),
        )
        .slice(0, 5);
      return {
        params: { slug: post.id },
        props: { post, html, related },
      };
    }),
  );
}

export default function BlogPost(props: {
  post: CollectionEntry;
  html: string;
  related: CollectionEntry[];
}) {
  return (
    <Layout title={props.post.data.title as string}>
      <PostDetail post={props.post} html={props.html} related={props.related} base="blog" />
    </Layout>
  );
}
