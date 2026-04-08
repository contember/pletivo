import Layout from "../components/Layout";
import Counter from "../islands/Counter";

export default function Home() {
  const features = [
    "JSX components rendered to static HTML",
    "Islands architecture for interactivity",
    "Content collections with Zod validation",
    "File-based routing with dynamic params",
    "Dev server with HMR",
  ];

  return (
    <Layout title="Pavouk - Home">
      <h1>Pavouk</h1>
      <p>A tiny Astro-like SSG framework powered by Bun.</p>

      <h2>Features</h2>
      <ul>
        {features.map((f) => (
          <li>{f}</li>
        ))}
      </ul>

      <h2>Interactive Island</h2>
      <p>This counter is an island - it ships JavaScript only for this component:</p>
      <Counter client="load" initial={0} __islandName="Counter" />
    </Layout>
  );
}
