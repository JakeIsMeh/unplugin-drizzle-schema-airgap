# unplugin-drizzle-schema-airgap

> Airgap your Drizzle-derived validators from your client-side bundle.

`unplugin-drizzle-schema-airgap` compile-time virtualizes your Drizzle schema files, allowing you to share validation adaptors (`drizzle-zod`, `drizzle-valibot`, etc.) across the client-server boundary without bloating your client bundles or leaking server-only dependencies.

## 🤖 LLM Disclosure

_85% Gemini-3.5-Flash and a smidge of Claude-Opus-4.6_  
_I steered the AI and did the reviews._

---

## Why?

When you derive client-side schemas (e.g. for form validation) from your Drizzle schemas using adaptors like `drizzle-zod`, your frontend build tool ends up importing `drizzle-orm` and all of its transitive dependencies.

This causes two major issues:

1. **Bundle Bloat:** Client bundles carry unnecessary database-specific query builders and drivers.
2. **Server Leakage / Build Crashes:** Schema files often import server utilities or Node.js-only modules (`pg`, `fs`, `net`, database client instances). Importing these in client-side code will crash your build pipeline.

### The Solution

At build-time, this plugin:

- Intercepts and shims validation adaptors (like `drizzle-zod`, `drizzle-valibot`, `drizzle-typebox`, `drizzle-effect`, and `drizzle-arktype`) with client-safe, Drizzle-free validation code.
- Compiles your schemas into lightweight, plain-object metadata in-memory (or to a physical cache file).
- Automatically sweeps your code to ensure unused schemas are never included in the frontend bundle.

---

## Installation

```bash
# Using pnpm
pnpm i -D github:JakeIsMeh/unplugin-drizzle-schema-airgap
```

---

## Configuration & Options

Add the plugin to your bundler configuration. Below are the available customization options:

```ts
export interface DrizzleSchemaAirgapOptions {
	/**
	 * Absolute or relative paths to directories containing your Drizzle schema files.
	 * e.g. ['./src/db/schemas']
	 */
	searchDirectories: string[];

	/**
	 * The file path where the generated client-side validation metadata will be saved.
	 * If omitted, the plugin compiles modules completely in-memory (virtual mode).
	 * Defaults to 'node_modules/.cache/drizzle-schema-airgap/validation.ts'.
	 */
	outputFilePath?: string;

	/**
	 * If true (default), the plugin only intercepts and transforms client-side targeted environments
	 * (e.g., Vite's client target). Keep this as true to allow server-side code to use the real Drizzle ORM.
	 */
	clientOnly?: boolean;

	/**
	 * List of sensitive column names to completely strip from client-side schema metadata.
	 * Use this to prevent sensitive fields (like 'passwordHash', 'stripeId') from leaking to frontend bundles.
	 * e.g. ['passwordHash', 'salt']
	 */
	stripColumns?: string[];
}
```

### Example Usage (Vite)

```ts
// vite.config.ts
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/vite';

export default defineConfig({
	plugins: [
		drizzleSchemaAirgap({
			searchDirectories: ['./src/db/schemas'],
			stripColumns: ['passwordHash', 'stripeId'], // Prevent sensitive columns from leaking to the browser
		}),
	],
});
```

---

## Bundler Setup Examples

<details>
<summary>Vite</summary><br>

```ts
// vite.config.ts
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/vite';

export default defineConfig({
	plugins: [
		drizzleSchemaAirgap({
			searchDirectories: ['./src/db/schemas'],
		}),
	],
});
```

<br></details>

<details>
<summary>Rollup</summary><br>

```ts
// rollup.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rollup';

export default {
	plugins: [
		drizzleSchemaAirgap({
			searchDirectories: ['./src/db/schemas'],
		}),
	],
};
```

<br></details>

<details>
<summary>Rolldown / tsdown</summary><br>

```ts
// rolldown.config.ts / tsdown.config.ts
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rolldown';

export default {
	plugins: [
		drizzleSchemaAirgap({
			searchDirectories: ['./src/db/schemas'],
		}),
	],
};
```

<br></details>

<details>
<summary>esbuild</summary><br>

```ts
import { build } from 'esbuild';
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/esbuild';

build({
	plugins: [
		drizzleSchemaAirgap({
			searchDirectories: ['./src/db/schemas'],
		}),
	],
});
```

<br></details>

<details>
<summary>Webpack</summary><br>

```js
// webpack.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/webpack';

export default {
	plugins: [
		drizzleSchemaAirgap({
			searchDirectories: ['./src/db/schemas'],
		}),
	],
};
```

<br></details>

<details>
<summary>Rspack</summary><br>

```ts
// rspack.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rspack';

export default {
	plugins: [
		drizzleSchemaAirgap({
			searchDirectories: ['./src/db/schemas'],
		}),
	],
};
```

<br></details>

---

## License

[ISC](./LICENSE) License © 2026
