#!/usr/bin/env bun
/**
 * Synthetic content generator for build benchmarking.
 *
 * Usage:  bun scripts/generate-content.ts
 *
 * Creates:
 *   src/content/blog/generated/post-XXXX.md   (BLOG_COUNT files)
 *   src/content/docs/generated/doc-XXXX.md    (DOCS_COUNT files)
 *   src/content/notes/generated/note-XXXX.md  (NOTES_COUNT files)
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const BLOG_COUNT = 1000;
const DOCS_COUNT = 300;
const NOTES_COUNT = 200;

const root = path.resolve(import.meta.dir, "..");

// Tiny seedable RNG so output is deterministic between runs.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "spider", "web", "static", "render", "build", "page", "island",
  "markdown", "content", "collection", "schema", "route", "loader",
  "frontmatter", "bundle", "tree", "node", "graph", "edge", "vertex",
  "compile", "parse", "token", "ast", "transform", "plugin", "hook",
  "cache", "stale", "fresh", "deploy", "ship", "fast", "slow", "byte",
  "kilobyte", "megabyte", "latency", "throughput", "benchmark", "sample",
  "score", "metric", "trace", "profile", "flame", "graph", "memory",
  "leak", "alloc", "gc", "thread", "fiber", "async", "await", "yield",
];

const TAGS = [
  "intro", "guide", "tutorial", "deep-dive", "perf", "bench", "ssg",
  "jsx", "bun", "markdown", "ops", "release", "rfc", "wip",
];

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

function paragraph(rand: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    let w = pick(rand, WORDS);
    if (i === 0) w = w[0]!.toUpperCase() + w.slice(1);
    out.push(w);
  }
  return out.join(" ") + ".";
}

function makeBody(rand: () => number, idx: number): string {
  const lines: string[] = [];
  lines.push(`# Post ${idx}`);
  lines.push("");
  lines.push(paragraph(rand, 30));
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(paragraph(rand, 40));
  lines.push("");
  lines.push("- " + paragraph(rand, 6));
  lines.push("- " + paragraph(rand, 6));
  lines.push("- " + paragraph(rand, 6));
  lines.push("- " + paragraph(rand, 6));
  lines.push("");
  lines.push("## Details");
  lines.push("");
  lines.push(paragraph(rand, 50));
  lines.push("");
  lines.push(paragraph(rand, 40));
  lines.push("");
  lines.push("> " + paragraph(rand, 12));
  lines.push("");
  return lines.join("\n");
}

function makeFrontmatter(rand: () => number, idx: number, kind: string): string {
  const dayOffset = Math.floor(rand() * 1000);
  const d = new Date(2024, 0, 1);
  d.setDate(d.getDate() + dayOffset);
  const date = d.toISOString().slice(0, 10);
  const tagCount = 1 + Math.floor(rand() * 3);
  const tags = new Set<string>();
  while (tags.size < tagCount) tags.add(pick(rand, TAGS));
  const draft = rand() < 0.05;
  const titleWords = 3 + Math.floor(rand() * 4);
  const title = Array.from({ length: titleWords }, () => pick(rand, WORDS)).join(" ");
  return [
    "---",
    `title: "${kind} ${idx}: ${title}"`,
    `date: ${date}`,
    `draft: ${draft}`,
    `tags: [${Array.from(tags).join(", ")}]`,
    "---",
  ].join("\n");
}

async function generate(
  dir: string,
  count: number,
  prefix: string,
  kind: string,
  seedBase: number,
) {
  const fullDir = path.join(root, dir);
  await rm(fullDir, { recursive: true, force: true });
  await mkdir(fullDir, { recursive: true });

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const rand = mulberry32(seedBase + i);
    const fm = makeFrontmatter(rand, i, kind);
    const body = makeBody(rand, i);
    const id = String(i).padStart(4, "0");
    const file = path.join(fullDir, `${prefix}-${id}.md`);
    tasks.push(writeFile(file, `${fm}\n\n${body}\n`));
  }
  await Promise.all(tasks);
  console.log(`  ${dir}: ${count} files`);
}

console.log("Generating synthetic content...");
await generate("src/content/blog/generated", BLOG_COUNT, "post", "Post", 1);
await generate("src/content/docs/generated", DOCS_COUNT, "doc", "Doc", 100_000);
await generate("src/content/notes/generated", NOTES_COUNT, "note", "Note", 200_000);
console.log("Done.");
