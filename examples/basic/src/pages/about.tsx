import Layout from "../components/Layout";

export default function About() {
  return (
    <Layout title="About">
      <h1>About</h1>
      <p>
        Pletivo is a static site generator that uses JSX components
        to render HTML at build time. No client-side JavaScript runtime needed.
      </p>
      <p>Built with Bun.</p>
    </Layout>
  );
}
