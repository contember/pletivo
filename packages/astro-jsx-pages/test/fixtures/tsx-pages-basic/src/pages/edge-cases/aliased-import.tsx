// Test: Aliased imports - import default as alias
import MyCounter from '../../components/Counter';

export const prerender = true;

export default function AliasedImportPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Aliased Import Test</title>
      </head>
      <body>
        <h1>Aliased Import Test</h1>
        <p>Testing import alias: Counter as MyCounter</p>
        <MyCounter client:load initial={42} />
      </body>
    </html>
  );
}
