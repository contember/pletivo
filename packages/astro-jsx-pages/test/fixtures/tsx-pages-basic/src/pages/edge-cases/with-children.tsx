// Test: Components with children/slots
import Wrapper from '../../components/Wrapper';
import Counter from '../../components/Counter';

export const prerender = true;

export default function WithChildrenPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Components With Children Test</title>
      </head>
      <body>
        <h1>Components With Children Test</h1>
        <p>Testing hydrated components that receive children:</p>

        <Wrapper client:load title="Interactive Wrapper">
          <p>This is child content inside a hydrated wrapper.</p>
          <span>More child content here.</span>
        </Wrapper>

        <Wrapper client:visible title="Visible Wrapper">
          <Counter initial={5} />
        </Wrapper>
      </body>
    </html>
  );
}
