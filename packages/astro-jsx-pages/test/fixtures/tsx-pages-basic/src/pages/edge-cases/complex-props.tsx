// Test: Complex props with special characters
import Counter from '../../components/Counter';
import Wrapper from '../../components/Wrapper';

export const prerender = true;

export default function ComplexPropsPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Complex Props Test</title>
      </head>
      <body>
        <h1>Complex Props Test</h1>

        {/* Props with special characters in string */}
        <Wrapper
          client:load
          title="Title with > and < symbols & quotes"
        >
          <p>Content</p>
        </Wrapper>

        {/* Props with curly braces and nested objects would be here,
            but Counter only accepts 'initial' prop */}
        <Counter client:visible initial={999} />

        {/* Multiple props on same line with client directive in middle */}
        <Wrapper title="Before" client:idle>
          <span>Inline content</span>
        </Wrapper>
      </body>
    </html>
  );
}
