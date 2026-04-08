export const prerender = true;

interface Props {
  title?: string;
}

export default function AboutPage({ title = 'About Us' }: Props) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{title}</title>
      </head>
      <body>
        <h1>{title}</h1>
        <p>This is the about page, also rendered from TSX.</p>
        <a href="/">Back to Home</a>
      </body>
    </html>
  );
}
