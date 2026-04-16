# astro:env Virtual Module

**Priority:** B-tier
**Status:** Done (commit 407851d)
**Area:** Virtual Modules / Configuration

## Problem

`astro:env` provides type-safe access to environment variables with schema validation. Without it, users fall back to raw `import.meta.env.X` or `process.env.X` with no validation.

## Current State

- No `astro:env` virtual module
- No `env.schema` / `envField()` support in config (though `envField` is exported from `astro/config` as a stub)

## Expected Behavior

Config:
```ts
// astro.config.ts
import { defineConfig, envField } from 'astro/config';
export default defineConfig({
  env: {
    schema: {
      API_URL: envField.string({ context: 'client', access: 'public' }),
      SECRET: envField.string({ context: 'server', access: 'secret' }),
    }
  }
});
```

Usage:
```ts
import { API_URL } from 'astro:env/client';
import { SECRET } from 'astro:env/server';
```

For SSG, both client and server variables are available at build time. The main value is schema validation and type safety.

## Files

- `packages/pletivo/src/astro-plugin.ts` — virtual module registration
- `packages/pletivo/src/astro-host/config-loader.ts` — config parsing
