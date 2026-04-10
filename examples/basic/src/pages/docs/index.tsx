import { getCollection } from "../../../../../packages/pletivo/src/content/collection";
import Layout from "../../components/Layout";
import PostList from "../../components/PostList";

export default async function DocsIndex() {
  const posts = await getCollection("docs", (entry) => !entry.data.draft);
  posts.sort((a, b) => (b.data.date as Date).getTime() - (a.data.date as Date).getTime());

  return (
    <Layout title="Docs">
      <PostList posts={posts} base="docs" title="Docs" />
    </Layout>
  );
}
