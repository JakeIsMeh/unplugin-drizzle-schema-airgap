# unplugin-drizzle-schema-airgap

Airgap your Drizzle-derived validators from your client-side bundle

## LLM Disclosure
85% Gemini-3.5-Flash + Claude-Opus-4.6

I was basically the backseat driver for this

## Usage

Derive your validators from your Drizzle schemas, and if imported on the client
bundle, the plugin will shim the schema to prevent your client bundle from pulling
in Drizzle and db related dependencies.

## Installation

```bash
# pnpm i -D unplugin-drizzle-schema-airgap # I'm not published yet!
pnpm i -D github:JakeIsMeh/unplugin-drizzle-schema-airgap
```

<details>
<summary>Vite</summary><br>

```ts
// vite.config.ts
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/vite'

export default defineConfig({
  plugins: [drizzleSchemaAirgap()],
})
```

<br></details>

<details>
<summary>Rollup</summary><br>

```ts
// rollup.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rollup'

export default {
  plugins: [drizzleSchemaAirgap()],
}
```

<br></details>

<details>
<summary>Rolldown / tsdown</summary><br>

```ts
// rolldown.config.ts / tsdown.config.ts
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rolldown'

export default {
  plugins: [drizzleSchemaAirgap()],
}
```

<br></details>

<details>
<summary>esbuild</summary><br>

```ts
import { build } from 'esbuild'
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/esbuild'

build({
  plugins: [drizzleSchemaAirgap()],
})
```

<br></details>

<details>
<summary>Webpack</summary><br>

```js
// webpack.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/webpack'

export default {
  /* ... */
  plugins: [drizzleSchemaAirgap()],
}
```

<br></details>

<details>
<summary>Rspack</summary><br>

```ts
// rspack.config.js
import drizzleSchemaAirgap from 'unplugin-drizzle-schema-airgap/rspack'

export default {
  /* ... */
  plugins: [drizzleSchemaAirgap()],
}
```

<br></details>

## License

[ISC](./LICENSE) License © 2026
