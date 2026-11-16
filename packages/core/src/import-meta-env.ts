/**
 * The global both hosts rewrite `import.meta.env` to. A global, because no module
 * can assign to another module's `import.meta`.
 */
export const IMPORT_META_ENV_GLOBAL = "__pletivoImportMetaEnv";
