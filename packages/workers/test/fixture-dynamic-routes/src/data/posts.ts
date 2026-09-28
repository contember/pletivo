/**
 * The fixture's data, as a plain module.
 *
 * Deliberately not a content collection: `getCollection` is not ported to the
 * Workers host, and every `getStaticPaths` fixture already in this repo is backed by
 * one — which is why this fixture exists at all. See `docs/todos/016`.
 */

export interface Post {
  slug: string;
  title: string;
  body: string;
}

export const POSTS: Post[] = [
  { slug: "hello-world", title: "Hello World", body: "The first post." },
  { slug: "second-post", title: "Second Post", body: "The second post." },
  { slug: "third-post", title: "Third Post", body: "The third post." },
];

export const TAGS = ["css", "html"];
