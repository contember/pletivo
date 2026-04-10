import { getCollection } from "../../../../../packages/pletivo/src/content/collection";
import Layout from "../../components/Layout";

export default async function BlogIndex() {
  const posts = await getCollection("blog");
  return (
    <Layout title="Blog">
      <h1>Blog</h1>
      <ul>
        {posts.map((p) => (
          <li><a href={`/blog/${p.id}`}>{p.data.title as string}</a></li>
        ))}
      </ul>
    </Layout>
  );
}
