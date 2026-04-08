import Counter from '../components/Counter';

export const prerender = true;

export default function EdgeCasesPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Edge Cases</title>
      </head>
      <body>
        <h1>Edge Cases Page</h1>

        {/* client:media with value */}
        <Counter client:media="(min-width: 768px)" initial={1} />

        {/* Self-closing without space before /> */}
        <Counter client:load initial={2}/>

        {/* Multiline props */}
        <Counter
          client:idle
          initial={3}
        />
      </body>
    </html>
  );
}
