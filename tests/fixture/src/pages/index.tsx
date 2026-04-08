import Layout from "../components/Layout";
import Counter from "../islands/Counter";

export default function Home() {
  return (
    <Layout title="Home">
      <h1>Home Page</h1>
      <Counter client="load" initial={5} />
    </Layout>
  );
}
