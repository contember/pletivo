/**
 * Tailwind's four stylesheets, read off disk.
 *
 * A test-only stand-in for what a real host worker does: its bundler embeds the same
 * four files as text and passes them to `renderPage`. Nothing in `src/` reads a file.
 */

import path from "node:path";
import type { TailwindStylesheets } from "../src/tailwind.ts";

let cached: Promise<TailwindStylesheets> | undefined;

/** `null` where `tailwindcss` is not installed, so a test can skip instead of fail. */
export function tailwindDir(): string | null {
  try {
    return path.dirname(Bun.resolveSync("tailwindcss/package.json", import.meta.dir));
  } catch {
    return null;
  }
}

export function tailwindStylesheets(): Promise<TailwindStylesheets> {
  cached ??= read();
  return cached;
}

async function read(): Promise<TailwindStylesheets> {
  const dir = tailwindDir();
  if (dir === null) throw new Error("tailwindcss is not installed");
  const file = (name: string) => Bun.file(path.join(dir, name)).text();
  return {
    tailwindcss: await file("index.css"),
    "tailwindcss/preflight": await file("preflight.css"),
    "tailwindcss/theme": await file("theme.css"),
    "tailwindcss/utilities": await file("utilities.css"),
  };
}
