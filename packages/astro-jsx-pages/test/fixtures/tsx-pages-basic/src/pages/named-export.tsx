export const prerender = true;

// Test named export pattern: const Page = ...; export default Page;
const NamedPage = () => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <title>Named Export</title>
    </head>
    <body>
      <h1>Named Export Pattern</h1>
      <p>This page uses const Page = ...; export default Page pattern.</p>
    </body>
  </html>
);

export default NamedPage;
