/** @jsxImportSource solid-js */
import { createSignal, type JSX } from "solid-js";

export default function Counter(props: { children?: JSX.Element }) {
  const [count] = createSignal(0);
  return (
    <>
      <div class="counter">
        <button>-</button>
        <pre>{count()}</pre>
        <button>+</button>
      </div>
      <div class="counter-message">{props.children}</div>
    </>
  );
}
