import Layout from "../components/Layout";

const accent = "salmon";

export default function Styled() {
  return (
    <Layout title="Styled">
      <style>{`
        .hero { color: tomato; padding: 1rem; }
      `}</style>
      <style>{`.footer-from-second-block { border-top: 1px solid ${accent}; }`}</style>
      <h1 class="hero">Styled Page</h1>
      <p class="footer-from-second-block">multiple style blocks supported</p>
    </Layout>
  );
}
