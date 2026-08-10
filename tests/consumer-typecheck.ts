#!/usr/bin/env bun
/**
 * Typecheck pletivo the way a downstream site does.
 *
 * `bun run typecheck` compiles the package inside this repo, where its own
 * devDependencies are installed and its tsconfig pins `types: ["bun"]`. A real
 * consumer has neither: it installs `dependencies` only, and compiles
 * `node_modules/pletivo/src/*.ts` as part of its own program (the exports map
 * points at raw `.ts`). Anything pletivo's src needs to typecheck must
 * therefore be a real dependency, and its syntax must be understood by the
 * oldest TypeScript the package claims to support.
 *
 * So: pack the package, install it into a throwaway project pinned to the
 * declared minimum TypeScript, and compile a page against it.
 */

import { mkdtemp, rm, writeFile, mkdir, readdir } from "fs/promises";
import os from "os";
import path from "path";

/** Lowest TypeScript pletivo claims to work with (package.json peerDependencies). */
const MIN_TYPESCRIPT = "5.7.3";

const pkgDir = path.join(import.meta.dir, "../packages/pletivo");
const tmp = await mkdtemp(path.join(os.tmpdir(), "pletivo-consumer-"));

function run(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: proc.exitCode === 0,
    output: proc.stdout.toString() + proc.stderr.toString(),
  };
}

function fail(message: string, output: string): never {
  console.error(`FAIL: ${message}\n${output}`);
  process.exit(1);
}

try {
  const packed = run(["bun", "pm", "pack", "--destination", tmp], pkgDir);
  if (!packed.ok) fail("could not pack packages/pletivo", packed.output);
  const tarball = (await readdir(tmp)).find((f) => f.endsWith(".tgz"));
  if (!tarball) fail("bun pm pack produced no tarball", packed.output);

  const project = path.join(tmp, "consumer");
  await mkdir(path.join(project, "src"), { recursive: true });

  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "pletivo-consumer-check",
        private: true,
        type: "module",
        dependencies: {
          pletivo: `file:${path.join(tmp, tarball)}`,
          // Declared peer — a real site installs it for islands.
          preact: "^10.29.1",
        },
        devDependencies: { typescript: MIN_TYPESCRIPT },
      },
      null,
      2,
    ),
  );

  // Deliberately no `types` pin: a consumer gets whatever @types its own
  // node_modules holds, which is exactly what we want to verify.
  await writeFile(
    path.join(project, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "pletivo",
          strict: true,
          skipLibCheck: true,
          module: "ESNext",
          moduleResolution: "bundler",
          target: "ESNext",
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );

  // Exercises the entry points a site actually touches: the root export, the
  // content subpath, JSX via `jsxImportSource`, and an island directive.
  await writeFile(
    path.join(project, "src/page.tsx"),
    `import { defineConfig } from "pletivo";
import { defineCollection, z } from "pletivo/content";

export const config = defineConfig({ srcDir: "src" });

export const collections = {
  blog: defineCollection({ schema: z.object({ title: z.string() }) }),
};

function Counter(props: { initial: number }) {
  return <span>{props.initial}</span>;
}

export default function Page() {
  return (
    <main>
      <h1>hello</h1>
      <Counter client="load" initial={0} />
    </main>
  );
}
`,
  );

  const install = run(["bun", "install", "--no-save"], project);
  if (!install.ok) fail("consumer install failed", install.output);

  const tsc = run(["./node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.json"], project);
  if (!tsc.ok) {
    fail(
      `a clean consumer (TypeScript ${MIN_TYPESCRIPT}) does not typecheck against the packed package.\n` +
        "Every type pletivo's src needs must be a real dependency, and its syntax must parse on the declared minimum TypeScript.",
      tsc.output,
    );
  }

  console.log(`OK: clean consumer typechecks against packed pletivo on TypeScript ${MIN_TYPESCRIPT}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
