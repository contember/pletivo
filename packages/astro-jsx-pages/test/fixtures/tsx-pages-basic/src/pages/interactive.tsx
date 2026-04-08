import Counter from '../components/Counter';

export const prerender = true;

export default function InteractivePage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Interactive Page</title>
      </head>
      <body>
        <h1>Interactive Page with Islands</h1>
        <p>Below is an interactive Counter component:</p>
        <Counter client:load initial={10} />
        <p>And another one that loads when visible:</p>
        <Counter client:visible initial={20} />
      </body>
    </html>
  );
}
