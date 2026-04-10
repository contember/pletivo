#!/usr/bin/env bash
#
# End-to-end build benchmark: pletivo vs native Astro on an identical
# synthetic content set (1000 blog + 300 docs + 200 notes markdown files).
#
# Usage:
#   scripts/benchmark.sh              # 5 runs per framework (default)
#   RUNS=10 scripts/benchmark.sh      # 10 runs
#   SKIP_GEN=1 scripts/benchmark.sh   # reuse existing synthetic content
#   ONLY=pletivo scripts/benchmark.sh  # just pletivo (or: astro)
#
# Reads nothing; prints a Markdown-ish table at the end.

set -euo pipefail

RUNS="${RUNS:-5}"
SKIP_GEN="${SKIP_GEN:-0}"
ONLY="${ONLY:-both}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLETIVO_DIR="$REPO_ROOT/examples/basic"
ASTRO_DIR="$REPO_ROOT/examples/basic-astro"

if [[ ! -d "$PLETIVO_DIR" ]]; then
  echo "error: pletivo example not found at $PLETIVO_DIR" >&2
  exit 1
fi
if [[ ! -d "$ASTRO_DIR" ]]; then
  echo "error: astro example not found at $ASTRO_DIR" >&2
  exit 1
fi

# ── Generate synthetic content ─────────────────────────────────────────
if [[ "$SKIP_GEN" != "1" ]]; then
  echo "▶ Generating synthetic content..."
  (cd "$PLETIVO_DIR" && bun scripts/generate-content.ts)

  echo "▶ Syncing content → astro example..."
  for col in blog docs notes; do
    rm -rf "$ASTRO_DIR/src/content/$col/generated"
    mkdir -p "$ASTRO_DIR/src/content/$col"
    cp -r "$PLETIVO_DIR/src/content/$col/generated" "$ASTRO_DIR/src/content/$col/"
  done
fi

# ── Helpers ────────────────────────────────────────────────────────────

# Print mean of a list of floats (awk, no external deps).
mean() {
  awk '{ s += $1; n++ } END { if (n > 0) printf "%.2f", s/n; else print "n/a" }'
}

# Run one timed build. Writes wall-clock seconds to stdout.
# Uses `/usr/bin/time -o` so the timing report goes to a separate file
# and does not collide with the build's own stdout/stderr.
time_build() {
  local dir="$1"
  local time_file="/tmp/pletivo-bench.time"
  (
    cd "$dir"
    /usr/bin/time -f "%e" -o "$time_file" bun run build > /tmp/pletivo-bench.log 2>&1
  )
  cat "$time_file"
}

run_pletivo() {
  echo ""
  echo "▶ pletivo: $RUNS clean builds"
  local times=()
  for i in $(seq 1 "$RUNS"); do
    rm -rf "$PLETIVO_DIR/dist"
    local t
    t=$(time_build "$PLETIVO_DIR")
    times+=("$t")
    printf "  run %d: %ss\n" "$i" "$t"
  done
  PLETIVO_MEAN=$(printf "%s\n" "${times[@]}" | mean)
  PLETIVO_RAW="${times[*]}"
}

run_astro_cold() {
  echo ""
  echo "▶ astro cold: 1 clean build (rm .astro + dist)"
  rm -rf "$ASTRO_DIR/dist" "$ASTRO_DIR/.astro" "$ASTRO_DIR/node_modules/.astro"
  ASTRO_COLD=$(time_build "$ASTRO_DIR")
  printf "  cold: %ss\n" "$ASTRO_COLD"
}

run_astro_warm() {
  echo ""
  echo "▶ astro warm: $RUNS builds (keep .astro, clear dist)"
  local times=()
  for i in $(seq 1 "$RUNS"); do
    rm -rf "$ASTRO_DIR/dist"
    local t
    t=$(time_build "$ASTRO_DIR")
    times+=("$t")
    printf "  run %d: %ss\n" "$i" "$t"
  done
  ASTRO_WARM_MEAN=$(printf "%s\n" "${times[@]}" | mean)
  ASTRO_WARM_RAW="${times[*]}"
}

# ── Run ────────────────────────────────────────────────────────────────
PLETIVO_MEAN="—"; PLETIVO_RAW=""
ASTRO_COLD="—"; ASTRO_WARM_MEAN="—"; ASTRO_WARM_RAW=""

case "$ONLY" in
  pletivo)
    run_pletivo
    ;;
  astro)
    run_astro_cold
    run_astro_warm
    ;;
  both|*)
    run_pletivo
    run_astro_cold
    run_astro_warm
    ;;
esac

# ── Report ─────────────────────────────────────────────────────────────
echo ""
echo "═══ Results (wall-clock seconds) ═══"
printf "%-18s | %-10s | %s\n" "framework" "mean" "runs"
printf "%-18s-+-%-10s-+-%s\n" "------------------" "----------" "------------------------------"
if [[ "$ONLY" != "astro" ]]; then
  printf "%-18s | %-10s | %s\n" "pletivo" "${PLETIVO_MEAN}s" "$PLETIVO_RAW"
fi
if [[ "$ONLY" != "pletivo" ]]; then
  printf "%-18s | %-10s | %s\n" "astro (cold, 1x)" "${ASTRO_COLD}s" "-"
  printf "%-18s | %-10s | %s\n" "astro (warm)" "${ASTRO_WARM_MEAN}s" "$ASTRO_WARM_RAW"
fi
echo ""
echo "(Astro warm = .astro cache from previous run. Cold = nothing cached.)"
