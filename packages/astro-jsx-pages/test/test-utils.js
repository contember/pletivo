import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Load a test fixture
 * @param {{ root: URL }} options
 */
export async function loadFixture({ root }) {
  const rootPath = fileURLToPath(root);
  let devServer = null;

  return {
    /**
     * Build the fixture
     */
    async build() {
      const { build } = await import('astro');
      await build({ root: rootPath, logLevel: 'silent' });
    },

    /**
     * Read a file from the dist directory
     * @param {string} path
     */
    async readFile(path) {
      const distPath = join(rootPath, 'dist', path);
      return readFile(distPath, 'utf-8');
    },

    /**
     * Start the dev server
     */
    async startDevServer() {
      const { dev } = await import('astro');
      devServer = await dev({ root: rootPath, logLevel: 'silent' });
      const address = devServer.address;
      const port = typeof address === 'object' ? address.port : 4321;
      const baseUrl = `http://localhost:${port}`;

      return {
        stop: () => devServer.stop(),
        address: devServer.address,
      };
    },

    /**
     * Fetch from the dev server
     * @param {string} path
     */
    async fetch(path) {
      if (!devServer) {
        throw new Error('Dev server not started');
      }
      const address = devServer.address;
      const port = typeof address === 'object' ? address.port : 4321;
      const url = `http://localhost:${port}${path}`;
      return fetch(url);
    },
  };
}
