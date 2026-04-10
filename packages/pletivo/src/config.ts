import path from "path";

export interface PletivoConfig {
  /** Output directory for build (default: "dist") */
  outDir: string;
  /** Dev server port (default: 3000) */
  port: number;
  /** Base path for deployment under a sub-path (default: "/") */
  base: string;
  /** Source directory (default: "src") */
  srcDir: string;
  /** Public directory for static assets (default: "public") */
  publicDir: string;
}

const defaults: PletivoConfig = {
  outDir: "dist",
  port: 3000,
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
