export default function Layout(props: { title: string; children?: unknown }) {
  return (
    <html lang="cs">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          {" | "}
          <a href="/about">About</a>
        </nav>
        <main>
          {props.children}
        </main>
      </body>
    </html>
  );
}
