export const prerender = true;

export default function IndexPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>TSX Pages - Home</title>
      </head>
      <body>
        <h1>Welcome to TSX Pages</h1>
        <p>This page is rendered from a TSX file!</p>
        <nav>
          <a href="/about">About</a> | <a href="/blog/hello-world">Blog Post</a>
        </nav>
      </body>
    </html>
  );
}
