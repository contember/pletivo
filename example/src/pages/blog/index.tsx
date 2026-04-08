import { getCollection } from "../../../../src/content/collection";
import Layout from "../../components/Layout";

export default async function BlogIndex() {
  const posts = await getCollection("blog", (entry) => !entry.data.draft);

  // Sort by date descending
  posts.sort((a, b) => {
    const da = a.data.date as Date;
    const db = b.data.date as Date;
    return db.getTime() - da.getTime();
  });

  return (
    <Layout title="Blog">
      <h1>Blog</h1>
      <ul>
        {posts.map((post) => (
          <li>
            <a href={`/blog/${post.id}`}>{post.data.title as string}</a>
            <time>{(post.data.date as Date).toLocaleDateString()}</time>
          </li>
        ))}
      </ul>
    </Layout>
  );
}
