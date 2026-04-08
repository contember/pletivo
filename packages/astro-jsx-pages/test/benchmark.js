/**
 * Benchmark: .astro vs .tsx page performance comparison
 *
 * Measures:
 * 1. Build time - total time to build the fixture
 * 2. Output size - size of generated HTML files
 * 3. Dev server response time - TTFB in dev mode (average of N samples)
 *
 * Run with: bun run benchmark
 */

import { performance } from 'node:perf_hooks';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from './test-utils.js';

const FIXTURE_ROOT = new URL('./fixtures/tsx-pages-basic/', import.meta.url);
const SAMPLES = 10;

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format milliseconds to human-readable string
 */
function formatMs(ms) {
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Measure response time for a URL
 */
async function measureResponseTime(fetchFn, path) {
  const start = performance.now();
  const response = await fetchFn(path);
  await response.text(); // Consume response
  const end = performance.now();
  return end - start;
}

/**
 * Get average response time over multiple samples
 */
async function getAverageResponseTime(fetchFn, path, samples = SAMPLES) {
  const times = [];

  // Warm up request
  await measureResponseTime(fetchFn, path);

  // Measure samples
  for (let i = 0; i < samples; i++) {
    times.push(await measureResponseTime(fetchFn, path));
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  return { avg, min, max };
}

async function runBenchmark() {
  console.log('='.repeat(60));
  console.log('  Benchmark: .astro vs .tsx Pages');
  console.log('='.repeat(60));
  console.log('');

  const fixture = await loadFixture({ root: FIXTURE_ROOT });
  const rootPath = fileURLToPath(FIXTURE_ROOT);

  // ─────────────────────────────────────────────────────────────
  // 1. BUILD TIME
  // ─────────────────────────────────────────────────────────────
  console.log('1. Build Time');
  console.log('-'.repeat(40));

  const buildStart = performance.now();
  await fixture.build();
  const buildTime = performance.now() - buildStart;

  console.log(`   Total build time: ${formatMs(buildTime)}`);
  console.log('');

  // ─────────────────────────────────────────────────────────────
  // 2. OUTPUT SIZE
  // ─────────────────────────────────────────────────────────────
  console.log('2. Output Size');
  console.log('-'.repeat(40));

  const pages = [
    { name: '.astro (test-astro)', path: 'test-astro/index.html' },
    { name: '.tsx (interactive)', path: 'interactive/index.html' },
    { name: '.tsx (index)', path: 'index.html' },
    { name: '.tsx (edge-cases)', path: 'edge-cases/index.html' },
  ];

  const sizes = [];
  for (const page of pages) {
    try {
      const content = await readFile(join(rootPath, 'dist', page.path), 'utf-8');
      const size = Buffer.byteLength(content, 'utf-8');
      sizes.push({ ...page, size, content: content.length });
      console.log(`   ${page.name.padEnd(25)} ${formatBytes(size).padStart(10)}  (${content.length} chars)`);
    } catch (error) {
      console.log(`   ${page.name.padEnd(25)} (not found)`);
    }
  }
  console.log('');

  // ─────────────────────────────────────────────────────────────
  // 3. DEV SERVER RESPONSE TIME
  // ─────────────────────────────────────────────────────────────
  console.log('3. Dev Server Response Time (TTFB)');
  console.log('-'.repeat(40));
  console.log(`   Samples per page: ${SAMPLES}`);
  console.log('');

  const devServer = await fixture.startDevServer();

  const devPages = [
    { name: '.astro (test-astro)', path: '/test-astro' },
    { name: '.tsx (interactive)', path: '/interactive' },
    { name: '.tsx (index)', path: '/' },
    { name: '.tsx (edge-cases)', path: '/edge-cases' },
  ];

  const responseTimes = [];
  for (const page of devPages) {
    try {
      const times = await getAverageResponseTime(fixture.fetch.bind(fixture), page.path);
      responseTimes.push({ ...page, ...times });
      console.log(`   ${page.name.padEnd(25)} avg: ${formatMs(times.avg).padStart(10)}  (min: ${formatMs(times.min)}, max: ${formatMs(times.max)})`);
    } catch (error) {
      console.log(`   ${page.name.padEnd(25)} (error: ${error.message})`);
    }
  }

  await devServer.stop();
  console.log('');

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  console.log('  Summary');
  console.log('='.repeat(60));

  // Compare .astro vs .tsx
  const astroSize = sizes.find(s => s.name.includes('.astro'));
  const tsxSize = sizes.find(s => s.name.includes('interactive'));
  const astroTime = responseTimes.find(r => r.name.includes('.astro'));
  const tsxTime = responseTimes.find(r => r.name.includes('interactive'));

  if (astroSize && tsxSize) {
    const sizeDiff = ((tsxSize.size - astroSize.size) / astroSize.size * 100).toFixed(1);
    console.log(`   Output size difference: ${sizeDiff > 0 ? '+' : ''}${sizeDiff}% (.tsx vs .astro)`);
  }

  if (astroTime && tsxTime) {
    const timeDiff = ((tsxTime.avg - astroTime.avg) / astroTime.avg * 100).toFixed(1);
    console.log(`   Response time difference: ${timeDiff > 0 ? '+' : ''}${timeDiff}% (.tsx vs .astro)`);
  }

  console.log('');
  console.log('Benchmark complete!');
  console.log('');

  // Return results as JSON for programmatic use
  return {
    buildTime,
    sizes: sizes.reduce((acc, s) => ({ ...acc, [s.path]: s.size }), {}),
    responseTimes: responseTimes.reduce((acc, r) => ({ ...acc, [r.path]: { avg: r.avg, min: r.min, max: r.max } }), {}),
  };
}

// Run benchmark
runBenchmark()
  .then((results) => {
    // Optionally output JSON results
    if (process.env.JSON_OUTPUT) {
      console.log(JSON.stringify(results, null, 2));
    }
  })
  .catch((error) => {
    console.error('Benchmark failed:', error);
    process.exit(1);
  });
