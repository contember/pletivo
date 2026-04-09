import { getCollection } from "../../../../../packages/pavouk/src/content/collection";
import Layout from "../../components/Layout";
import PostList from "../../components/PostList";

export default async function NotesIndex() {
  const posts = await getCollection("notes", (entry) => !entry.data.draft);
  posts.sort((a, b) => (b.data.date as Date).getTime() - (a.data.date as Date).getTime());

  return (
    <Layout title="Notes">
      <PostList posts={posts} base="notes" title="Notes" />
    </Layout>
  );
}
