import { getCollection } from "../../../../../packages/pletivo/src/content/collection";
import Layout from "../../components/Layout";
import PostList from "../../components/PostList";

export default async function BlogIndex() {
  const posts = await getCollection("blog", (entry) => !entry.data.draft);
  posts.sort((a, b) => (b.data.date as Date).getTime() - (a.data.date as Date).getTime());

  return (
    <Layout title="Blog">
      <PostList posts={posts} base="blog" title="Blog" />
    </Layout>
  );
}
