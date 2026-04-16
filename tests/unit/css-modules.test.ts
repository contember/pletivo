import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { registerCssModulesPlugin, getCssModulesOutput, clearCssModules } from "../../packages/pletivo/src/css-modules";

// We need a real .module.css file to test the Bun plugin
const tmpDir = path.join(import.meta.dir, "../fixture-css-modules");
const cssFile = path.join(tmpDir, "Card.module.css");

describe("CSS Modules", () => {
  beforeAll(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      cssFile,
      `.card { padding: 1rem; border: 1px solid #ccc; }
.card .title { font-weight: bold; }
.card .description { color: #666; }
.active { background: blue; }`,
    );
    await registerCssModulesPlugin();
    clearCssModules();
  });

  afterAll(async () => {
    clearCssModules();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("import returns class name mapping", async () => {
    const mod = await import(cssFile);
    const styles = mod.default;
    expect(styles).toBeTypeOf("object");
    expect(styles.card).toBeTypeOf("string");
    expect(styles.title).toBeTypeOf("string");
    expect(styles.description).toBeTypeOf("string");
    expect(styles.active).toBeTypeOf("string");
  });

  test("scoped names include file basename and hash", async () => {
    const mod = await import(cssFile);
    const styles = mod.default;
    // Pattern: Card_className_hash
    expect(styles.card).toMatch(/^Card_card_[a-f0-9]+$/);
    expect(styles.title).toMatch(/^Card_title_[a-f0-9]+$/);
    expect(styles.active).toMatch(/^Card_active_[a-f0-9]+$/);
  });

  test("different classes get the same file hash", async () => {
    const mod = await import(cssFile);
    const styles = mod.default;
    const hash1 = styles.card.split("_").pop();
    const hash2 = styles.title.split("_").pop();
    expect(hash1).toBe(hash2);
  });

  test("generated CSS uses scoped class names", () => {
    const output = getCssModulesOutput();
    expect(output).toBeTruthy();
    // Should contain scoped class names, not original ones
    expect(output).toContain("Card_card_");
    expect(output).toContain("Card_title_");
    expect(output).toContain("padding: 1rem");
    expect(output).toContain("font-weight: bold");
  });

  test("clearCssModules empties the output", () => {
    clearCssModules();
    expect(getCssModulesOutput()).toBe("");
  });
});
