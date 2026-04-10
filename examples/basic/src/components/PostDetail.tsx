import type { CollectionEntry } from "../../../../packages/pletivo/src/content/collection";

export default function PostDetail(props: {
  post: CollectionEntry;
  html: string;
  related: CollectionEntry[];
  base: string;
}) {
  const { post, html, related, base } = props;
  const date = post.data.date as Date;
  const tags = (post.data.tags as string[] | undefined) ?? [];
  const wordCount = post.body.split(/\s+/).length;
  const readingTime = Math.max(1, Math.round(wordCount / 200));

  return (
    <article class="post-detail">
      <header class="post-header">
        <nav class="breadcrumbs">
          <a href="/">Home</a>
          <span> / </span>
          <a href={`/${base}`}>{base}</a>
          <span> / </span>
          <span class="current">{post.id}</span>
        </nav>
        <h1>{post.data.title as string}</h1>
        <div class="post-meta">
          <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time>
          <span class="dot">·</span>
          <span>{wordCount} words</span>
          <span class="dot">·</span>
          <span>{readingTime} min read</span>
        </div>
        {tags.length > 0 && (
          <ul class="tags">
            {tags.map((t) => (
              <li class="tag">
                <a href={`/${base}?tag=${encodeURIComponent(t)}`}>#{t}</a>
              </li>
            ))}
          </ul>
        )}
      </header>

      <div class="post-body" dangerouslySetInnerHTML={{ __html: html }} />

      <footer class="post-footer">
        <div class="share">
          <h3>Share</h3>
          <ul>
            <li><a href={`#share-twitter-${post.id}`}>Twitter</a></li>
            <li><a href={`#share-mastodon-${post.id}`}>Mastodon</a></li>
            <li><a href={`#share-bluesky-${post.id}`}>Bluesky</a></li>
          </ul>
        </div>

        {related.length > 0 && (
          <aside class="related">
            <h3>Related</h3>
            <ul>
              {related.map((r) => (
                <li>
                  <a href={`/${base}/${r.id}`}>
                    <span class="title">{r.data.title as string}</span>
                    <time>{(r.data.date as Date).toLocaleDateString()}</time>
                  </a>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </footer>
    </article>
  );
}
