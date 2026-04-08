/** @jsxImportSource react */
import { useState } from 'react';
import ThemedCounter, { ThemeContext, UserContext } from '../components/ThemedCounter';

export const prerender = true;

export default function ReactWithContextsPage() {
  // React hooks fungují v page komponentě
  const [theme] = useState<'light' | 'dark'>('dark');
  const [user] = useState({ name: 'Jan Novák' });

  return (
    <ThemeContext.Provider value={theme}>
      <UserContext.Provider value={user}>
        <html lang="en">
          <head>
            <meta charSet="utf-8" />
            <title>React Page with Contexts</title>
          </head>
          <body style={{ fontFamily: 'sans-serif', padding: '20px' }}>
            <h1>React Page with Context Hydration</h1>

            <p>Tato stránka demonstruje předání React kontextů do hydratovaných islands.</p>

            <h2>Island s kontexty (automaticky propagované):</h2>
            <ThemedCounter initial={100} />

            <h2>Další island se stejnými kontexty:</h2>
            <ThemedCounter initial={200} />
          </body>
        </html>
      </UserContext.Provider>
    </ThemeContext.Provider>
  );
}
