import { useState } from "preact/hooks";
export default function Counter({ start = 0, children }) {
  const [n, setN] = useState(start);
  return <div class="counter"><button onClick={() => setN(n + 1)}>{n}</button>{children}</div>;
}
export function Named() {
  return <i>named</i>;
}
