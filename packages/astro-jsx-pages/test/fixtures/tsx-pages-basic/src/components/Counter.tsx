import { useState } from 'react';

// This component can be used with client:* directives in .astro files
// or imported into TSX pages (but won't be interactive without hydration)
export default function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}
