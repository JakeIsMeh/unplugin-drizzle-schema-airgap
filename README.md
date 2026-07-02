# unplugin-drizzle-schema-airgap

Airgap your Drizzle-derived validators from client-side bundles.

### Features

- **Universal**: Support major build tools (Vite, Webpack, Rollup, Rspack, etc.) via unplugin.
- **On-demand**: Compile validation schemas into lightweight, plain-object metadata in-memory.
- **Type-safe**: Full TypeScript support with virtual path mappings and autocomplete.
- **Secure**: Prevent server-only database drivers or credentials from leaking to frontend bundles.

---

## Installation

```bash
npm i -D unplugin-drizzle-schema-airgap
```

---

## Usage

Import client-side schemas using the `/airgap` suffix. This completely decouples Drizzle ORM from client builds.

```ts
import { selectUserSchema } from './db/schema/users/airgap'

// Autocomplete and validation work normally, minus Drizzle bundle bloat!
```

To enable IDE autocompletion and compile-time type-safety, extend your `tsconfig.json` with the generated configuration:

```json
{
  "extends": "./.drizzle-airgap/tsconfig.json"
}
```

### Adaptor Shimming

The plugin automatically intercepts and shims imports referencing validation adaptors at build time. This allows you to write standard derivation code in shared modules:

```ts
import { createSelectSchema } from 'drizzle-orm/zod'
import { users } from './schema/users/airgap'

export const selectUserSchema = createSelectSchema(users)
```

The following adaptors are fully shimmed with client-safe, Drizzle-free implementations:

- `drizzle-orm/zod` (and legacy `drizzle-zod`)
- `drizzle-orm/valibot` (and legacy `drizzle-valibot`)
- `drizzle-orm/typebox`
- `drizzle-orm/effect-schema`
- `drizzle-orm/arktype`

---

## Column Stripping & Visibility

### Global Stripping

Configure columns to strip globally across all schemas using the `omitColumns` option:

```ts
drizzleSchemaAirgap({
  searchDirectories: ['./src/db/schemas'],
  omitColumns: ['passwordHash', 'salt'],
})
```

### Magic Comment Directives

Define table-specific and view-specific rules directly in your schema files:

### `omit`

Remove specific columns from client metadata (local counterpart to `omitColumns` option):

```ts
/* @drizzle-airgap omit passwordHash, salt */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  passwordHash: text('password_hash'),
})
```

### `pick`

Keep only the listed columns (secure-by-default):

```ts
/* @drizzle-airgap pick id, name */
export const profiles = pgTable('profiles', {
  id: serial('id').primaryKey(),
  name: text('name'),
  secretToken: text('secret_token'), // stripped
})
```

These directives work with inline, multiline, or JSDoc comments.

---

## Import Guardrails

If a client-side module imports directly from a raw schema (e.g. `from './db/schema'`), the plugin emits a build warning prompting you to use the `/airgap` suffix instead.

---

## Configuration

This section covers how to configure `unplugin-drizzle-schema-airgap` for different build tools.

### Build Tools

<details>
<summary>Vite</summary><br>

```ts
// vite.config.ts
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/vite'

export default defineConfig({
  plugins: [
    drizzleSchemaAirgap({
      searchDirectories: ['./src/db/schemas'],
    }),
  ],
})
```

<br></details>

<details>
<summary>Rollup</summary><br>

```ts
// rollup.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rollup'

export default {
  plugins: [
    drizzleSchemaAirgap({
      searchDirectories: ['./src/db/schemas'],
    }),
  ],
}
```

<br></details>

<details>
<summary>Rolldown</summary><br>

```ts
// rolldown.config.ts
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rolldown'

export default {
  plugins: [
    drizzleSchemaAirgap({
      searchDirectories: ['./src/db/schemas'],
    }),
  ],
}
```

<br></details>

<details>
<summary>esbuild</summary><br>

```ts
import { build } from 'esbuild'
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/esbuild'

build({
  plugins: [
    drizzleSchemaAirgap({
      searchDirectories: ['./src/db/schemas'],
    }),
  ],
})
```

<br></details>

<details>
<summary>Webpack</summary><br>

```ts
// webpack.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/webpack'

export default {
  plugins: [
    drizzleSchemaAirgap({
      searchDirectories: ['./src/db/schemas'],
    }),
  ],
}
```

<br></details>

<details>
<summary>Rspack</summary><br>

```ts
// rspack.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rspack'

export default {
  plugins: [
    drizzleSchemaAirgap({
      searchDirectories: ['./src/db/schemas'],
    }),
  ],
}
```

<br></details>

### Options

```ts
export interface DrizzleSchemaAirgapOptions {
  /**
   * Absolute or relative paths to directories containing your Drizzle schema files.
   */
  searchDirectories: string[]

  /**
   * The file path where the generated client-side validation metadata will be saved.
   * If omitted, the plugin compiles modules completely in-memory (virtual mode).
   * Defaults to 'node_modules/.cache/drizzle-schema-airgap/validation.ts'.
   */
  outputFilePath?: string

  /**
   * If true (default), only intercept and transform client-side targeted environments.
   */
  clientOnly?: boolean

  /**
   * List of sensitive column names to completely strip from client-side schema metadata.
   */
  omitColumns?: string[]
}
```

---

## License

[ISC](./LICENSE) License © 2026
