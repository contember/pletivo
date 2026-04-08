import Layout from "../components/Layout";

export default function Home() {
  const features = ["JSX components", "Static site generation", "Dev server with HMR"];

  return (
    <Layout title="Pavouk - Home">
      <h1>Pavouk</h1>
      <p>A tiny Astro-like SSG framework powered by Bun.</p>
      <ul>
        {features.map((f) => (
          <li>{f}</li>
        ))}
      </ul>
    </Layout>
  );
}
