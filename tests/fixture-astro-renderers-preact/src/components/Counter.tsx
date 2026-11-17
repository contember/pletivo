import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import "./Counter.css";

export default function Counter({ start, children }: { start: number; children?: ComponentChildren }) {
  const [count, setCount] = useState(start);
  return (
    <div class="preact-counter">
      <button onClick={() => setCount(count + 1)}>preact {count}</button>
      <div class="message">{children}</div>
    </div>
  );
}
