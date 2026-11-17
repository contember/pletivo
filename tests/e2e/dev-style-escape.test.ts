import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

// A page's own CSS is inlined as `<style>`; a `</style` inside it must not end the element early.
const repoRoot = path.join(import.meta.dir, "../..");
const runtime = path.join(repoRoot, "packages/runtime/src");
const PORT = 7800 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

const CSS = '.a::before{content:"</style><b>x</b>"}.b::before{content:"</STYLE><b>y</b>"}';

function page(marker: string): string {
  return `export default function Page() {\n` +
    `  return <html><head><title>t</title></head><body><style>{${JSON.stringify(CSS)}}</style><p id="after">${marker}</p></body></html>;\n` +
    `}\n`;
}

let root: string;
let serverProcess: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-dev-style-escape-"));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "pletivo",
        paths: {
          "pletivo/jsx-runtime": [path.join(runtime, "jsx-runtime.ts")],
          "pletivo/jsx-dev-runtime": [path.join(runtime, "jsx-runtime.ts")],
          "preact/hooks": [path.join(runtime, "hooks.ts")],
        },
      },
    }),
    "src/pages/index.tsx": page("route page"),
    "src/pages/404.tsx": page("not found page"),
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  serverProcess = Bun.spawn(
    ["bun", "run", path.join(repoRoot, "packages/pletivo/src/cli.ts"), "dev", String(PORT), "--no-restart"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Dev server did not start in time");
});

afterAll(async () => {
  serverProcess.kill();
  await serverProcess.exited;
  await fs.rm(root, { recursive: true, force: true });
});

/** What a spec-conforming HTML parser sees: each `<style>`'s text, `<b>` count, and the `#after` text. */
async function parse(html: string): Promise<{ styles: string[]; bold: number; after: string[] }> {
  const styles: string[] = [];
  const after: string[] = [];
  let bold = 0;
  await new HTMLRewriter()
    .on("style", {
      element() {
        styles.push("");
      },
      text(chunk) {
        styles[styles.length - 1] += chunk.text;
      },
    })
    .on("b", {
      element() {
        bold++;
      },
    })
    .on("p#after", {
      text(chunk) {
        if (chunk.text) after.push(chunk.text);
      },
    })
    .transform(new Response(html))
    .text();
  return { styles, bold, after };
}

describe("dev server - </style inside inlined CSS", () => {
  const cases: { label: string; pathname: string; status: number; marker: string }[] = [
    { label: "a route page", pathname: "/", status: 200, marker: "route page" },
    { label: "the custom 404 page", pathname: "/missing", status: 404, marker: "not found page" },
  ];
  for (const { label, pathname, status, marker } of cases) {
    test(`${label} keeps the whole CSS inside one <style> and the markup after it`, async () => {
      const res = await fetch(BASE + pathname);
      expect(res.status).toBe(status);
      const html = await res.text();
      const { styles, bold, after } = await parse(html);
      const own = styles.filter((text) => text.includes(".a::before"));
      expect(own).toEqual(['.a::before{content:"<\\/style><b>x</b>"}.b::before{content:"<\\/STYLE><b>y</b>"}']);
      // Exactly one closing tag per style element.
      expect(html.match(/<\/style/gi)).toHaveLength(styles.length);
      expect(bold).toBe(0);
      expect(after.join("")).toBe(marker);
    });
  }
});
