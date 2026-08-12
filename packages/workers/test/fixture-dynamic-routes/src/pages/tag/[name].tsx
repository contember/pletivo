import { POSTS, TAGS } from "../../data/posts.ts";
import type { Post } from "../../data/posts.ts";

interface Props {
  name: string;
  posts: Post[];
  __pageContext: { params: Record<string, string | undefined> };
}

// A .tsx dynamic route. The call convention differs from .astro — a compiled Astro
// page takes `(result, props, slots)` and this one takes plain props — so both need
// their own path through the isolate entry.
export function getStaticPaths() {
  return TAGS.map((name, index) => ({
    params: { name },
    props: { name, posts: POSTS.slice(index) },
  }));
}

export default function TagPage({ name, posts, __pageContext }: Props) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{name}</title>
      </head>
      <body>
        <h1>{name}</h1>
        <p id="param">{__pageContext.params.name}</p>
        <ul id="tagged">
          {posts.map((post) => (
            <li>{post.title}</li>
          ))}
        </ul>
      </body>
    </html>
  );
}
