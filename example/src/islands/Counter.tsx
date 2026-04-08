import { useState } from "pavouk/hooks";

export default function Counter(props: { initial: number }) {
  const [count, setCount] = useState(props.initial);
  return (
    <button onClick={() => setCount((c) => c + 1)}>
      Count: {count}
    </button>
  );
}
