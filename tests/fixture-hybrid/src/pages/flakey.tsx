import fs from "fs";

export default function Flakey() {
  const marker = process.env.PLETIVO_TEST_BREAK_MARKER;
  if (marker && fs.existsSync(marker)) {
    throw new Error("intentional break: marker file exists");
  }
  return (
    <html>
      <head>
        <title>Flakey OK</title>
      </head>
      <body>
        <h1>Flakey OK</h1>
        <p>render token: stable-body</p>
      </body>
    </html>
  );
}
