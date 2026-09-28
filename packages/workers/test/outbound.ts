/**
 * `globalOutbound` in real workerd: what a rendering page reaches, and what it does
 * not. Not a `bun test` file — like `parity.ts` it needs a workerd listening, so it is
 * driven by hand.
 *
 *   bunx wrangler@4 dev --config packages/workers/example/wrangler.jsonc --port 8799
 *   bun packages/workers/test/outbound.ts
 *
 * `test/outbound.test.ts` checks the code object the host hands the Loader. It cannot
 * check what workerd does with it: `FileLoader` imports the bundle into the test
 * process, where a `fetch()` in a page would reach the real network. This is where the
 * field is enforced, and the more important of the two cases is the first one — that
 * the default really does stop a page from getting out, rather than merely intending
 * to.
 *
 * Nothing here touches the Internet. The origin the fixture fetches is served by the
 * example worker's own `PletivoOutbound` (see `example/src/api.ts`), so a run that
 * "passes" cannot be a run that quietly reached the real world.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Glob } from "bun";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const FIXTURE = path.join(import.meta.dir, "fixture-outbound");
const workerUrl = process.argv[2] ?? "http://localhost:8799";

/** What the example worker serves the isolate, and what the fixture asks it for. */
const API_ORIGIN = "https://api.pletivo.test";
const FIRST_POST = "Rendered from a live API";

const files: Record<string, string> = {};
for await (const rel of new Glob("**/*").scan({ cwd: FIXTURE, dot: false })) {
  files[rel] = await fs.readFile(path.join(FIXTURE, rel), "utf8");
}

interface Render {
  status: number;
  body: string;
}

async function render(pathname: string, outbound?: "proxy"): Promise<Render> {
  const response = await fetch(`${workerUrl}/__render`, {
    method: "POST",
    body: JSON.stringify({ files, pathname, outbound }),
  });
  return { status: response.status, body: await response.text() };
}

const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  = ${name}`);
    return;
  }
  failures.push(`  ! ${name}\n${detail.split("\n").slice(0, 12).map((line) => `      ${line}`).join("\n")}`);
}

// ── The default: no outbound stub, so the page cannot get out ──────────

const cutOff = await render("/");
check(
  "a page that fetches fails when no outbound stub was configured",
  cutOff.status !== 200,
  `HTTP ${cutOff.status}, expected the render to fail\n${cutOff.body}`,
);
check(
  "…and reached nothing, rather than rendering what the API would have returned",
  !cutOff.body.includes(FIRST_POST),
  cutOff.body,
);
check(
  "…and the failure names the page, not the bundle",
  cutOff.body.includes("rendering src/pages/index.astro failed"),
  cutOff.body,
);
check(
  // workerd's own wording, and worth pinning: it is the difference between knowing
  // the page was denied the network and knowing only that something went wrong.
  "…and says the isolate is not permitted to reach the internet",
  /not permitted to access the internet/i.test(cutOff.body),
  cutOff.body,
);
console.log(`\n  the isolate reported:\n${indent(cutOff.body, 3)}\n`);

// ── With a proxy: the page reaches exactly what the host serves ────────

const proxied = await render("/", "proxy");
check(
  "the same page renders when the host hands it an outbound binding",
  proxied.status === 200,
  `HTTP ${proxied.status}\n${proxied.body}`,
);
check(
  "the API response is in the HTML",
  proxied.body.includes(FIRST_POST) && proxied.body.includes('<p id="status">200</p>'),
  proxied.body,
);
check(
  "the astro:env values arrived — the API refuses a request without the token",
  proxied.body.includes(`<p id="base">${API_ORIGIN}</p>`),
  proxied.body,
);

// ── The proxy is a filter, not a door ─────────────────────────────────

const elsewhere = await render("/elsewhere", "proxy");
check(
  "an origin the proxy does not serve comes back refused",
  elsewhere.status === 200 && elsewhere.body.includes('<p id="status">403</p>'),
  `HTTP ${elsewhere.status}\n${elsewhere.body}`,
);

console.log(`\n${path.relative(REPO_ROOT, FIXTURE)}: ${failures.length === 0 ? "ok" : `${failures.length} failed`}`);
for (const failure of failures) console.log(`\n${failure}`);
process.exit(failures.length === 0 ? 0 : 1);

/** The first `lines` of a body, indented, so a run records what workerd actually said. */
function indent(body: string, lines: number): string {
  return body
    .split("\n")
    .slice(0, lines)
    .map((line) => `    ${line}`)
    .join("\n");
}
