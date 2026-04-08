// Test: client:only directive - component not rendered on server
import Counter from '../../components/Counter';

export const prerender = true;

export default function ClientOnlyPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Client Only Test</title>
      </head>
      <body>
        <h1>Client Only Test</h1>
        <p>This counter should NOT be server-rendered:</p>
        <div id="client-only-container">
          <Counter client:only="react" initial={99} />
        </div>
        <p>But this one should be (client:load):</p>
        <div id="client-load-container">
          <Counter client:load initial={50} />
        </div>
      </body>
    </html>
  );
}
