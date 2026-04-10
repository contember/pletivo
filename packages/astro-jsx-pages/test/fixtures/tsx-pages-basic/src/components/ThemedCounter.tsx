/** @jsxImportSource react */
import { createContext, useContext, useState } from 'react';
import { asIsland } from '@pletivo/astro-jsx-pages/react-island-runtime';

// Exportujeme kontexty pro použití v page
export const ThemeContext = createContext<'light' | 'dark'>('light');
export const UserContext = createContext<{ name: string }>({ name: 'Guest' });

interface ThemedCounterProps {
  initial: number;
}

function ThemedCounter({ initial }: ThemedCounterProps) {
  const theme = useContext(ThemeContext);
  const user = useContext(UserContext);
  const [count, setCount] = useState(initial);

  const bgColor = theme === 'dark' ? '#333' : '#fff';
  const textColor = theme === 'dark' ? '#fff' : '#333';

  return (
    <div style={{ backgroundColor: bgColor, color: textColor, padding: '20px', borderRadius: '8px' }}>
      <p>Theme: {theme}</p>
      <p>User: {user.name}</p>
      <p>Count: {count}</p>
      <button onClick={() => setCount(c => c + 1)}>Increment</button>
    </div>
  );
}

export default asIsland(ThemedCounter, {
  client: 'load',
  contexts: {
    theme: ThemeContext,
    user: UserContext,
  },
});
