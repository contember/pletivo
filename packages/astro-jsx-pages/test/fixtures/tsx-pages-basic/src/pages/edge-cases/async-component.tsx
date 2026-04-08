import Counter from '../../components/Counter';

export const prerender = true;

// Async page component - tests that async functions work correctly
export default async function AsyncPage() {
  // Simulate async data fetching
  const data = await Promise.resolve({ title: 'Async Page', count: 25 });

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{data.title}</title>
      </head>
      <body>
        <h1>{data.title}</h1>
        <p>This page component is async</p>
        <p>Fetched count: {data.count}</p>
        <Counter client:load initial={data.count} />
      </body>
    </html>
  );
}
