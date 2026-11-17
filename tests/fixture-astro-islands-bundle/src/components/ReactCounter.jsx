/** @jsxImportSource react */
import { useState } from "react";
import "./counter.css";

export function Counter({ start = 0 }) {
  const [count, setCount] = useState(start);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}

export function Label({ text }) {
  return <span>{text}</span>;
}
