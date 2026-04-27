import path from "path";
import type { PluggableList } from "unified";

export interface MdxConfig {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
}

export interface DevHybridConfig {
  /** Page rendered to normal requests when a render fails. Relative to projectRoot. */
  errorPage?: string;
  /** Serve last-good snapshot per route to normal requests on render failure. */
  stale?: boolean;
  /**
   * Request header name that flips a request into debug view — raw errors + HMR overlay
   * instead of the user-facing fallback. Defaults to `x-pletivo-debug` when `errorPage` or
   * `stale` is enabled. With both off, no filtering happens and every request is in debug view.
   */
  debugHeader?: string;
}

export interface PletivoConfig {
  /** Output directory for build (default: "dist") */
  outDir: string;
  /** Dev server port (default: 3000) */
  port: number;
  /** Dev server host (default: "localhost") */
  host: string;
  /** Base path for deployment under a sub-path (default: "/") */
  base: string;
  /** Source directory (default: "src") */
  srcDir: string;
  /** Public directory for static assets (default: "public") */
  publicDir: string;
  /** MDX compilation options (remark/rehype plugins) */
  mdx?: MdxConfig;
  /** Path to custom 404 page (relative to projectRoot). Overrides the `pages/404.*` convention. */
  notFoundPage?: string;
  /** Dev-time dual-render config: agents see errors, users see overlay or snapshot. */
  dev?: DevHybridConfig;
}

const defaults: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  host: "localhost",
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

let configVersion = 0;

export async function loadConfig(projectRoot: string): Promise<PletivoConfig> {
  const candidates = [
    "pletivo.config.ts",
    "pletivo.config.js",
  ];

  for (const file of candidates) {
    const configPath = path.join(projectRoot, file);
    const configFile = Bun.file(configPath);
    if (await configFile.exists()) {
      configVersion++;
      const mod = await import(configPath + `?v=${configVersion}`);
      const userConfig = mod.default || {};
      return { ...defaults, ...userConfig };
    }
  }

  return { ...defaults };
}

export function defineConfig(config: Partial<PletivoConfig>): Partial<PletivoConfig> {
  return config;
}
