import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    build: {
      // Vite's function form: a boolean decides, undefined falls back to 4096 B.
      assetsInlineLimit(filePath, content) {
        const code = content.toString();
        if (!filePath.endsWith(".js")) return undefined;
        if (code.includes("fn-linked-marker")) return false;
        if (code.includes("fn-inlined-marker")) return true;
        return undefined;
      },
    },
  },
});
