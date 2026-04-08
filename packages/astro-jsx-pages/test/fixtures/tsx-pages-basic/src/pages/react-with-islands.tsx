/** @jsxImportSource react */
import Counter from '../components/Counter';

export const prerender = true;

export default function ReactWithIslandsPage() {
  // This uses React JSX runtime, so hooks would work here
  // But islands should also work through automatic transformation
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>React Page with Islands</title>
      </head>
      <body>
        <h1>React Page with Islands</h1>
        <p>This page uses React JSX runtime but still supports islands:</p>
        <Counter client:load initial={42} />
      </body>
    </html>
  );
}
