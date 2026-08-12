// The same collections from a `.tsx` route, which reaches the content module through
// a different compiler path than `.astro` does — sucrase rather than
// `@astrojs/compiler`. Both have to land on the one module instance, or this page
// would query a store the config never filled.
import { getCollection, type CollectionEntry } from "astro:content";

interface Author {
  name: string;
  site: string;
}

interface Post {
  title: string;
  date: Date;
  /** What `reference("authors")` stores: the id, resolvable with `getEntry`. */
  author: { collection: string; id: string };
  draft: boolean;
  tags: string[];
}

export async function getStaticPaths() {
  const authors = await getCollection<Author>("authors");
  const posts = await getCollection<Post>("posts");
  return authors.map((author) => ({
    params: { id: author.id },
    props: {
      author,
      // Resolved here rather than in the component: the reference marker is what a
      // schema stores, and matching on it is what proves it survived validation.
      written: posts.filter((post) => post.data.author.id === author.id),
    },
  }));
}

export default function AuthorPage(props: {
  author: CollectionEntry<Author>;
  written: CollectionEntry<Post>[];
}) {
  const { author, written } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{author.data.name}</title>
      </head>
      <body>
        <h1>{author.data.name}</h1>
        <a id="site" href={author.data.site}>
          {author.data.site}
        </a>
        <ul id="written">
          {written.map((post) => (
            <li>{post.data.title}</li>
          ))}
        </ul>
      </body>
    </html>
  );
}
