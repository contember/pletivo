// @ts-nocheck — test fixture, no type checking needed
import testImage from "../assets/test.png";

export default function ImagePage() {
  // In a real page, users would use <Image> from astro:components.
  // This fixture tests the ESM import + getImage pipeline directly.
  return (
    <html lang="en">
      <head>
        <title>Image Test</title>
      </head>
      <body>
        <h1>Image Test</h1>
        <img
          src={testImage.src}
          width={testImage.width}
          height={testImage.height}
          alt="test"
        />
        <script
          type="application/json"
          id="image-meta"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(testImage),
          }}
        />
      </body>
    </html>
  );
}
