// Test: Named exports from component (not default export)
import { NamedCounter, AnotherComponent } from '../../components/NamedExports';

export const prerender = true;

export default function NamedComponentExportPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Named Component Export Test</title>
      </head>
      <body>
        <h1>Named Component Export Test</h1>
        <p>Testing named exports from component file:</p>
        <NamedCounter client:load initial={100} />
        <AnotherComponent client:visible text="Visible text" />
      </body>
    </html>
  );
}
