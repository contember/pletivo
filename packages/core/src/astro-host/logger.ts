import type { IntegrationLogger } from "./types";

/**
 * Minimal logger mirroring Astro's IntegrationLogger interface.
 * Prefixes messages with `[<label>]`. `fork()` derives a child with a
 * nested label.
 */
export function createLogger(label: string): IntegrationLogger {
  const self: IntegrationLogger = {
    options: { dest: null, level: "info" },
    label,
    fork(child: string) {
      return createLogger(`${label}/${child}`);
    },
    info(message: string) {
      console.log(`  [${label}] ${message}`);
    },
    warn(message: string) {
      console.warn(`  [${label}] ${message}`);
    },
    error(message: string) {
      console.error(`  [${label}] ${message}`);
    },
    debug(_message: string) {
      // silent by default
    },
  };
  return self;
}
