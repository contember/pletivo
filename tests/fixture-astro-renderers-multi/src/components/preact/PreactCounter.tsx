/** @jsxImportSource preact */
import { useState } from "preact/hooks";

export function PreactCounter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>preact {count}</button>;
}
