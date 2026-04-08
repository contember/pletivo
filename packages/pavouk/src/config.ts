import path from "path";

export interface PavoukConfig {
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

const defaults: PavoukConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

let configVersion = 0;

export async function loadConfig(projectRoot: string): Promise<PavoukConfig> {
  const candidates = [
    "pavouk.config.ts",
    "pavouk.config.js",
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

export function defineConfig(config: Partial<PavoukConfig>): Partial<PavoukConfig> {
  return config;
}
