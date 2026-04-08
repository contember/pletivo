import { useState } from 'react';

// Component with named export (not default)
export function NamedCounter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);

  return (
    <div className="named-counter">
      <p>Named Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment Named</button>
    </div>
  );
}

// Another named export
export function AnotherComponent({ text = 'Hello' }: { text?: string }) {
  const [visible, setVisible] = useState(true);

  return (
    <div className="another-component">
      {visible && <p>{text}</p>}
      <button onClick={() => setVisible(!visible)}>Toggle</button>
    </div>
  );
}

// Default export too
export default function DefaultFromNamedFile({ value = 0 }: { value?: number }) {
  return <div className="default-component">Default: {value}</div>;
}
