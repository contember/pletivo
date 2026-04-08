import Counter from '../../components/Counter';

export const prerender = true;

// Test conditional rendering with client directives
export default function ConditionalRenderPage() {
  const showCounter = true;
  const showSecondCounter = false;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Conditional Render Test</title>
      </head>
      <body>
        <h1>Conditional Render Test</h1>

        {/* Conditional with client directive */}
        {showCounter && <Counter client:load initial={111} />}

        {/* Ternary with client directive */}
        {showSecondCounter ? (
          <Counter client:visible initial={222} />
        ) : (
          <p>Second counter is hidden</p>
        )}

        {/* Conditional in array */}
        <div>
          {[1, 2, 3].map((num) => (
            num % 2 === 1 ? (
              <Counter key={num} client:idle initial={num * 100} />
            ) : null
          ))}
        </div>
      </body>
    </html>
  );
}
