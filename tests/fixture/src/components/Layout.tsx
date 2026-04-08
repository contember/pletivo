export default function Layout(props: { title: string; children?: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{props.title}</title>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}
