# Astro 7 — Feature Evaluation & Backport Candidates

**Date:** 2026-06-23
**Astro version:** 7.0.0 ([blog](https://astro.build/blog/astro-7/))

## TL;DR

Astro 7 is a **performance release built on three Rust pieces**: a new Rust `.astro`
compiler, a Rust markdown processor (Sätteri), and Vite 8 / Rolldown (Rust bundler).
The net effect on pletivo's value proposition is real: on identical synthetic markdown,
Astro 7 closed most of the build-time gap, and at docs scale (~6k pages) **pletivo is now
slower than Astro** (see [benchmark](#benchmark-snapshot)).

The single highest-value backport is **native/cached markdown processing** — it's where
pletivo's scaling regression lives. Everything else is either SSG-irrelevant, low-ROI, or
a nice-to-have. Astro's Vite-8/Rolldown story is Astro catching up to native-speed
bundling that pletivo *already* has via Bun — nothing to backport, but it's *why* the gap
closed.

## Astro 7 stack (verified from installed deps)

| Piece | Package | Replaces | Pletivo today |
|---|---|---|---|
| `.astro` compiler | `@astrojs/compiler-rs@0.2.2` (Rust) | Go `@astrojs/compiler` | Go `@astrojs/compiler@3` |
| Markdown | `@astrojs/markdown-satteri` + native `satteri` (Rust) | unified default | unified/remark |
| Bundler | `vite@8` + `rolldown` (Rust) | esbuild/Rollup | Bun (`Bun.build`/`Bun.Transpiler`) |

`@astrojs/markdown-remark` (unified) is kept by Astro as an opt-in fallback for projects
that need remark/rehype plugins.

## Benchmark snapshot

Identical synthetic markdown content, this Linux box, warm mean (s). Full matrix in the
session memory note `astro-7-eval-findings`.

| scale | pletivo | Astro 7 | Astro 6 | Astro 5 |
|---|---|---|---|---|
| 1,500 pages | **3.28** | 3.72 (cold 4.12) | 5.05 | 5.60 |
| 6,000 pages | 14.02 | **12.79** (cold 12.3) | 12.38 | 11.40 |

- Pletivo **won at 1.5k** but **lost at 6k** — it did not scale linearly. The markdown
  pipeline was the cause (below); **fixed by adopting Sätteri** — see the clean A/B next.
- Caveat: synthetic content is plain markdown (no MDX / syntax highlighting / components),
  which *understates* Sätteri's advantage. On real Starlight-style docs pletivo would
  likely look relatively worse.

### Clean A/B after the Sätteri fix (quiet-ish machine, load 8–14, 5 runs, warmed)

| scale | pletivo **Sätteri** | pletivo unified (old) | Astro 7 |
|---|---|---|---|
| 1,500 | **1.04 s** | 3.41 s | 3.52 s (cold 4.70) |
| 6,000 | **3.95 s** (3.75–4.18, stable) | 15.49 s | ~10–11 s¹ |

¹ Astro 7 @ 6k was noisy (mean 16.93 inflated by a 33.78 s outlier under a load spike to 28;
representative ~10–11 s, matching its 11.43 s cold). pletivo-Sätteri was rock-stable.

- **Sätteri vs old unified:** 3.3× (1.5k), 3.9× (6k) — the regression is gone.
- **pletivo-Sätteri vs Astro 7:** 3.4× (1.5k), ~2.6× (6k vs Astro's best run).
- **Scaling:** pletivo-Sätteri 1.04 → 3.95 s for 4× the content (~3.8×, near-linear); old
  unified was 3.41 → 15.49 s (4.5×, super-linear). The crossover is gone — **pletivo now
  leads at both scales, and the lead grows with site size.**

## Feature-by-feature verdict

| Astro 7 feature | Pletivo today | Verdict | Tier |
|---|---|---|---|
| Sätteri (Rust markdown) | unified, fresh processor per file | **Backport (perf)** | **A** |
| Queued rendering (~2.4×) | recursive `renderChildren` | Investigate / measure | B |
| Rust compiler behavior (whitespace, strictness) | Go compiler v3 | Parity tests, don't switch engine | B |
| Background dev server / JSON logging | basic dev + HMR | Nice-to-have (agents) | C |
| `src/fetch.ts` routing | — | Skip (SSR-only) | — |
| Route caching + CDN providers | — | Skip (SSR/adapter-only) | — |
| Vite 8 / Rolldown | Bun (already native) | Skip (already covered) | — |

### A — Markdown processing (the real win) — ✅ IMPLEMENTED

> **Outcome (2026-06-23):** Profiling killed the cheap idea and confirmed the deep one.
> Caching the unified processor gave **~1.06× (nothing)** — the cost is the per-document
> unified processing itself (~1.4 ms/file, single-threaded JS, ~60% of a large build).
> A spike compared **Sätteri (native Rust, ~32–44×)** vs **markdown-it (pure JS, ~47×)** vs
> **unified-on-workers (~6×)**. We adopted **Sätteri** (it IS Astro 7's `.md` engine, so its
> output matches Astro — strengthening drop-in compat — whereas markdown-it diverges and
> abandons the remark ecosystem). `content/markdown.ts` now renders `.md` via Sätteri by
> default and **falls back to the unified pipeline when the user configures remark/rehype
> plugins** (Sätteri can't run them). Heading-id slugger is shared, so anchors are
> byte-identical; only difference is entity serialization (`&#x3C;`→`&lt;`, = Astro 7),
> costing 2 test-assertion edits. **Result: the 6k build dropped ~14 s → ~5 s (~2.7×), now
> faster than Astro 7 at docs scale.** Cost: adds the native `satteri` dependency (wasm
> fallback for arm64-linux/musl). Final clean A/B benchmark pending a quiet machine.

**What Astro did:** replaced the unified pipeline with Sätteri (Rust). Markdown-heavy
builds saw the biggest gains; the Astro docs build dropped "over a minute."

**Pletivo today:** `packages/pletivo/src/content/markdown.ts` builds a **fresh `unified()`
processor on every `.md` file** (≈line 154, "A fresh processor is built per call") and runs
the full remark→rehype tree in JS. That's O(n) expensive allocations + JS AST work that
does not amortize — the most likely cause of the 6k regression.

**Two backport paths, cheap → deep:**
1. **Reuse/cache the processor** (and the parsed plugin chain) across files instead of
   rebuilding per call. Cheap, keeps full remark/rehype plugin compatibility, should
   recover a chunk of the scaling loss. Do this first, behind the 6k profile.
2. **Adopt `satteri()` for plain `.md`**, fall back to unified only when the user
   configured remark/rehype plugins — exactly Astro's playbook. Big win, larger change,
   adds a native dependency. Decide after (1) + profiling.

→ Tie this to the parked 6k-slowdown debug. Files: `content/markdown.ts`, `mdx-plugin.ts`.

### B — Queued rendering

**What Astro did:** swapped recursive component rendering for a single queue loop, "~2.4×"
faster, now stable.

**Pletivo today:** `runtime/jsx-runtime.ts` `renderChildren` is recursive with `Promise.all`
over arrays, but it renders straight to strings and only goes async when it hits a Promise —
a different model from Astro's `Result`/`renderComponent` recursion. Astro's 2.4× was
against *their* deep recursive trees; it's not obvious it maps to pletivo.

**Verdict:** measure pletivo's render share at 6k first (part of the profile). Only worth a
rewrite if rendering — not markdown/IO — turns out to dominate.

### B — Rust compiler: parity, not adoption

Astro 7 moved `.astro` compilation to `@astrojs/compiler-rs`. Two separate questions:

- **(a) Behavior parity (compat risk, matters).** The Rust compiler changes output:
  whitespace between inline elements is now **collapsed (JSX rules)**, unclosed tags /
  unterminated attributes are **errors** (no auto-correction), and HTML is no longer
  silently rewritten. Pletivo uses the Go compiler (v3), so for the same `.astro` source it
  may now emit **different HTML than Astro 7** — eroding "drop-in compatible." Action: add
  fixtures covering whitespace-collapse and strictness, document the known differences.
- **(b) Switching pletivo to `compiler-rs` (perf, low ROI).** Astro measured the compiler
  at only "~6%" of build time in isolation — not pletivo's bottleneck. `compiler-rs` is
  early (0.2.x) and would mean migrating off `@astrojs/compiler`'s `transform`/`parse` API
  (`astro-plugin.ts`, peerDep `^2 || ^3`). **Don't switch the engine now.**

### C — Background dev server / JSON logging

`astro dev --background` (process managed in the background, auto-enabled for AI agents +
lockfile) and structured JSON logging. Pletivo's audience explicitly includes AI agents, so
this is a reasonable DX add later; low effort, not urgent. Files: `dev.ts`, `cli.ts`.

### Skip

- **`src/fetch.ts` routing** and **route caching / CDN providers** — SSR/adapter features;
  pletivo is SSG-only.
- **Vite 8 / Rolldown** — pletivo already bundles with Bun (native). This is Astro reaching
  parity with what pletivo already has; it's the *reason* the benchmark gap closed, not a
  backport target.

## Parked (tracked separately)

- **6k scaling regression** — profile pletivo's docs build (markdown vs render vs IO) to
  confirm the markdown suspect before changing anything. User-flagged priority.
- **Starlight support** — probed (Astro 6.4.8 + Starlight 0.40). Cascade is deep: shim
  lacks `markdown.processor` and `config.legacy`, Starlight needs a real `unified()`/
  `satteri()` processor it can extend, and behind it sits Expressive Code + Pagefind + MDX +
  sitemap + `virtual:starlight/*` + ~40 components. Multi-week + moving target (Starlight
  peers Astro 6, not 7). **Near-term park.**

## Recommended order

1. ✅ Profile the 6k build → markdown confirmed as the bottleneck (~60%, single-threaded).
2. ✅ ~~Backport A.1 (cache the unified processor)~~ — **disproven** (~1.06×); skipped.
3. ✅ Backport **A.2** — adopted **Sätteri** for `.md` with unified fallback. 6k build ~14 s → ~5 s.
4. ✅ Clean A/B benchmark (pletivo-Sätteri vs unified vs Astro 7) — Sätteri leads at both scales; see above.
5. ☐ Add **B** compiler parity fixtures (whitespace/strictness) for drop-in correctness.
6. ☐ Defer queued-rendering, background-dev, and Starlight until the above lands.
