export const prerender = true;

// Test component that returns a fragment
// Note: Full HTML pages need <html> but fragments could be used in partials
function FragmentContent() {
  return (
    <>
      <p>First paragraph in fragment</p>
      <p>Second paragraph in fragment</p>
    </>
  );
}

export default function FragmentReturnPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Fragment Return Test</title>
      </head>
      <body>
        <h1>Fragment Return Test</h1>
        <p>Testing fragment content:</p>
        <FragmentContent />
        <p>After fragment content</p>
      </body>
    </html>
  );
}
