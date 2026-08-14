import path from "path";
import type { CompileOptions } from "@mdx-js/mdx";
import {
  imageServiceConfigFromEnv,
  type ImageServiceConfig,
} from "./image-service";

// `unified`'s `PluggableList` isn't re-exported by @mdx-js/mdx and `unified`
// itself isn't a direct dependency (only resolvable transitively), so derive
// the type from the published `CompileOptions` instead of importing it.
type PluggableList = NonNullable<CompileOptions["remarkPlugins"]>;

export interface MdxConfig {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
}

export interface ImageConfig {
  /**
   * Image service used for Astro `<Image>` / `<Picture>` output.
   * - "sharp" (default): build-time resize + re-encode into `_astro/`.
   * - "passthrough": copy originals and emit their `_astro/` URLs.
   * - "cloudflare": copy originals and emit `/cdn-cgi/image/...` URLs.
   * Custom services can provide another URL-based resize adapter.
   * If unset, `PLETIVO_IMAGE_SERVICE` may change the default.
   */
  service?: ImageServiceConfig;
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
  /**
   * Replace the serving process after this many ms without a request. Off by default.
   *
   * A dev server does not give all of its memory back. Most of it is allocator arenas that
   * do come back eventually, but the runtime's native side (bun's mimalloc arena — live
   * caches plus fragmentation) only ever grows, so a long-lived server ratchets upwards no
   * matter how idle it is. Where several dev servers share one machine, the only way to
   * return that memory is a fresh process.
   *
   * Needs a supervisor; without a parent to bring the server back, exiting would just kill
   * it. `PLETIVO_DEV_IDLE_RECYCLE_MS` sets the same thing for hosts that spawn `pletivo dev`
   * but do not own the project's config file.
   */
  idleRecycleMs?: number;
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
  /**
   * Hash public assets (images/fonts/css/js) with a content hash and rewrite
   * references in rendered HTML. Default: true. Set to false to keep original
   * asset paths — needed when assets are referenced from places the build
   * can't rewrite (e.g. hardcoded paths inside island JS bundles, or url()s in
   * a Tailwind-generated CSS bundle). (default: true)
   */
  hashAssets?: boolean;
  /** Image output service (default: "sharp"). */
  image?: ImageConfig;
  /** MDX compilation options (remark/rehype plugins) */
  mdx?: MdxConfig;
  /** Path to custom 404 page (relative to projectRoot). Overrides the `pages/404.*` convention. */
  notFoundPage?: string;
  /** Dev-time dual-render config: agents see errors, users see overlay or snapshot. */
  dev?: DevHybridConfig;
}

export function resolveImageServiceConfig(
  config: Pick<PletivoConfig, "image">,
  env?: Record<string, string | undefined>,
): ImageServiceConfig | undefined {
  return config.image?.service ?? imageServiceConfigFromEnv(env);
}

const defaults: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  host: "localhost",
  base: "/",
  srcDir: "src",
  publicDir: "public",
  hashAssets: true,
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
