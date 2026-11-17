import { useState } from "react";
import "./Counter.css";

export function Counter({ start, children }) {
  const [count, setCount] = useState(start);
  return (
    <div className="react-counter">
      <button onClick={() => setCount(count + 1)}>react {count}</button>
      <div className="message">{children}</div>
    </div>
  );
}
