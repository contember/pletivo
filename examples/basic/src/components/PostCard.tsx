import type { CollectionEntry } from "../../../../packages/pletivo/src/content/collection";

export default function PostCard(props: {
  post: CollectionEntry;
  base: string;
  index: number;
}) {
  const { post, base, index } = props;
  const date = post.data.date as Date;
  const tags = (post.data.tags as string[] | undefined) ?? [];
  const draft = post.data.draft as boolean;
  return (
    <li class={`card card-${index % 4}`}>
      <article>
        <header>
          <h3>
            <a href={`/${base}/${post.id}`}>{post.data.title as string}</a>
          </h3>
          <div class="meta">
            <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time>
            {draft && <span class="badge badge-draft">draft</span>}
            <span class="badge badge-id">#{index}</span>
          </div>
        </header>
        {tags.length > 0 && (
          <ul class="tags">
            {tags.map((t) => (
              <li class="tag">
                <a href={`/${base}?tag=${encodeURIComponent(t)}`}>#{t}</a>
              </li>
            ))}
          </ul>
        )}
        <footer>
          <a href={`/${base}/${post.id}`} class="read-more">
            Read more →
          </a>
        </footer>
      </article>
    </li>
  );
}
