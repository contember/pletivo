/** @jsxImportSource solid-js */
import { createSignal } from "solid-js";

export default function SolidCounter() {
  const [count, setCount] = createSignal(0);
  return <button onClick={() => setCount(count() + 1)}>solid {count()}</button>;
}
