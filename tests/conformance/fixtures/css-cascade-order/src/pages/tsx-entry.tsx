// A TSX page is not compiled by the .astro loader, so its imports are read
// off disk when the cascade order is needed.
import First from "../components/First.astro";
import Second from "../components/Second.astro";

export default function Page() {
  return (
    <html lang="en">
      <head><title>tsx entry</title></head>
      <body>
        <Second />
        <First />
      </body>
    </html>
  );
}
