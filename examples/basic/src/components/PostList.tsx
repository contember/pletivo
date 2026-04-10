import type { CollectionEntry } from "../../../../packages/pletivo/src/content/collection";
import PostCard from "./PostCard";

export default function PostList(props: {
  posts: CollectionEntry[];
  base: string;
  title: string;
}) {
  const { posts, base, title } = props;

  // Build tag → count map (synthetic extra work for benchmarking).
  const tagCounts = new Map<string, number>();
  for (const post of posts) {
    const tags = (post.data.tags as string[] | undefined) ?? [];
    for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Year buckets.
  const byYear = new Map<number, CollectionEntry[]>();
  for (const post of posts) {
    const y = (post.data.date as Date).getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(post);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);

  return (
    <section class="post-list">
      <header class="page-header">
        <h1>{title}</h1>
        <p class="lead">
          Showing <strong>{posts.length}</strong> entries across{" "}
          <strong>{years.length}</strong> years and{" "}
          <strong>{sortedTags.length}</strong> distinct tags.
        </p>
      </header>

      <aside class="tag-cloud">
        <h2>Popular tags</h2>
        <ul>
          {sortedTags.slice(0, 12).map(([tag, count]) => (
            <li>
              <a href={`/${base}?tag=${encodeURIComponent(tag)}`}>
                #{tag} <span class="count">({count})</span>
              </a>
            </li>
          ))}
        </ul>
      </aside>

      {years.map((year) => {
        const yearPosts = byYear.get(year)!;
        return (
          <section class="year-group">
            <h2>{year}</h2>
            <p class="year-meta">{yearPosts.length} entries</p>
            <ul class="cards">
              {yearPosts.map((post, i) => (
                <PostCard post={post} base={base} index={i} />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
