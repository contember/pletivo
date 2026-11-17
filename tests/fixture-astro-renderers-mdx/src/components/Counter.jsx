import { useState } from "preact/hooks";

export default function Counter({ children }) {
  const [count, setCount] = useState(0);
  return (
    <div class="mdx-counter">
      <button onClick={() => setCount(count + 1)}>mdx {count}</button>
      <div class="message">{children}</div>
    </div>
  );
}
