import { useState } from "preact/hooks";

export default function Counter({ start }: { start: number }) {
  const [count, setCount] = useState(start);
  return <button onClick={() => setCount(count + 1)}>preact {count}</button>;
}
