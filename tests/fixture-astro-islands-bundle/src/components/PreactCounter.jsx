/** @jsxImportSource preact */
import { useState } from "preact/hooks";

export default function PreactCounter({ start = 0 }) {
  const [count, setCount] = useState(start);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
