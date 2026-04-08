// Test: Multiple components from same barrel import + aliased named import
import { Counter, Button as MyButton, Wrapper } from '../../components';

export const prerender = true;

export default function BarrelImportPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Barrel Import Test</title>
      </head>
      <body>
        <h1>Barrel Import Test</h1>
        <p>Testing multiple components from barrel import (components/index.ts):</p>

        <div id="counter-section">
          <Counter client:load initial={10} />
        </div>

        {/* Button imported as MyButton - tests aliased named import */}
        <div id="button-section">
          <MyButton client:visible label="Aliased Button" />
        </div>

        <div id="wrapper-section">
          <Wrapper client:idle title="From Barrel">
            <p>Content in barrel-imported wrapper</p>
          </Wrapper>
        </div>
      </body>
    </html>
  );
}
