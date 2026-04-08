import type { GetStaticPaths } from 'astro';

export const prerender = true;

// Dynamic routes work too!
export const getStaticPaths: GetStaticPaths = async () => {
  const posts = [
    { slug: 'hello-world', title: 'Hello World', content: 'This is my first post!' },
    { slug: 'second-post', title: 'Second Post', content: 'Another great post.' },
  ];

  return posts.map((post) => ({
    params: { slug: post.slug },
    props: post,
  }));
};

interface Props {
  title: string;
  content: string;
}

export default function BlogPost({ title, content }: Props) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{title}</title>
      </head>
      <body>
        <article>
          <h1>{title}</h1>
          <p>{content}</p>
        </article>
        <a href="/">Back to Home</a>
      </body>
    </html>
  );
}
