import Layout from "../components/Layout";
import Counter from "../islands/Counter";
import BrowserWidget from "../islands/BrowserWidget";

export default function Home() {
  return (
    <Layout title="Home">
      <h1>Home Page</h1>
      <Counter client="load" initial={5} />
      <BrowserWidget client="only" label="viewport" />
    </Layout>
  );
}
