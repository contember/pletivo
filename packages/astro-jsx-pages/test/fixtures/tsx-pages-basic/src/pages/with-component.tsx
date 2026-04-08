import Counter from '../components/Counter';

export const prerender = true;

export default function WithComponentPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Page with Component</title>
      </head>
      <body>
        <h1>Page with React Component</h1>
        <p>Below is a Counter component (now with hydration):</p>
        <Counter client:load initial={5} />
        <a href="/">Back to Home</a>
      </body>
    </html>
  );
}
