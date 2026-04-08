import Counter from '../../components/Counter';

export const prerender = true;

// Test what happens when multiple client directives are on one component
// Only the first one should be used
export default function MultipleDirectivesPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Multiple Directives Test</title>
      </head>
      <body>
        <h1>Multiple Client Directives Test</h1>
        <p>This tests a component with multiple client directives:</p>
        {/* The plugin should handle this gracefully - typically first directive wins */}
        <Counter client:load client:visible initial={99} />
        <p>The counter above has both client:load and client:visible</p>
      </body>
    </html>
  );
}
