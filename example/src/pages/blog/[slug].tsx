import { getCollection } from "../../../../src/content/collection";
import type { CollectionEntry } from "../../../../src/content/collection";
import Layout from "../../components/Layout";

export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
}

export default function BlogPost(props: { post: CollectionEntry }) {
  const { post } = props;
  return (
    <Layout title={post.data.title as string}>
      <article>
        <h1>{post.data.title as string}</h1>
        <time>{(post.data.date as Date).toLocaleDateString()}</time>
        {post.data.tags && (
          <div class="tags">
            {(post.data.tags as string[]).map((tag) => (
              <span class="tag">{tag}</span>
            ))}
          </div>
        )}
        <div dangerouslySetInnerHTML={{ __html: post.html }} />
      </article>
    </Layout>
  );
}
