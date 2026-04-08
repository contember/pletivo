import { useState } from 'react';

export default function Button({ label = 'Click me' }: { label?: string }) {
  const [clicked, setClicked] = useState(false);

  return (
    <button onClick={() => setClicked(true)}>
      {clicked ? 'Clicked!' : label}
    </button>
  );
}
