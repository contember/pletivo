// Test: String containing "client:" should not cause false positives
import Counter from '../../components/Counter';

export const prerender = true;

export default function StringFalsePositivePage() {
  const instructions = "Use client:load for immediate hydration, client:visible for lazy loading.";
  const codeExample = `<Counter client:load initial={5} />`;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>String False Positive Test</title>
      </head>
      <body>
        <h1>String False Positive Test</h1>
        <p>Instructions: {instructions}</p>
        <pre><code>{codeExample}</code></pre>
        <p>The actual hydrated component:</p>
        <Counter client:load initial={77} />
      </body>
    </html>
  );
}
