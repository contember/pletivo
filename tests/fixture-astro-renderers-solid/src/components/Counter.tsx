import { createSignal, type JSX } from "solid-js";
import "./Counter.css";

export default function Counter(props: { start: number; children?: JSX.Element }) {
  const [count, setCount] = createSignal(props.start);
  return (
    <div class="solid-counter">
      <button onClick={() => setCount(count() + 1)}>solid {count()}</button>
      <div class="message">{props.children}</div>
    </div>
  );
}
