import Counter from '../../components/Counter';
import Wrapper from '../../components/Wrapper';

export const prerender = true;

// Test template literal props with client directives
export default function TemplateLiteralPropsPage() {
  const name = 'User';
  const baseCount = 10;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Template Literal Props Test</title>
      </head>
      <body>
        <h1>Template Literal Props Test</h1>

        {/* Template literal in title prop with client:load */}
        <Wrapper client:load title={`Hello ${name}`}>
          <p>Content inside wrapper with template literal title</p>
        </Wrapper>

        {/* Computed initial value */}
        <Counter client:visible initial={baseCount * 2} />

        {/* Template literal in other context */}
        <div data-info={`Count is ${baseCount}`}>
          <Counter client:idle initial={baseCount + 5} />
        </div>
      </body>
    </html>
  );
}
