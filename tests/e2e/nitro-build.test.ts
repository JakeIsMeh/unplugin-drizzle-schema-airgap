import * as fs from 'node:fs';
import * as path from 'node:path';

import { createNitro, build, prepare } from 'nitro/builder';
import { describe, it, expect, beforeAll } from 'vitest';

import drizzleAirgap from '../../src/rollup';

describe('Nitro E2E Build', () => {
	const outDir = path.resolve(__dirname, '../../test-artifacts/nitro-out');
	const srcDir = path.resolve(__dirname, '../../test-artifacts/nitro-src');

	beforeAll(() => {
		if (fs.existsSync(srcDir)) {
			fs.rmSync(srcDir, { recursive: true, force: true });
		}
		if (fs.existsSync(outDir)) {
			fs.rmSync(outDir, { recursive: true, force: true });
		}
	});

	it('should compile a Nitro project and NOT intercept schemas (due to server target)', async () => {
		// Setup temporary Nitro structure
		fs.mkdirSync(path.join(srcDir, 'routes'), { recursive: true });
		fs.writeFileSync(
			path.join(srcDir, 'routes/index.ts'),
			`import { userSelectSchema } from '../../../tests/fixtures/consumer';
export default defineEventHandler(() => {
return { userSelectSchema };
});`,
		);

		const nitro = await createNitro({
			rootDir: srcDir,
			serverDir: srcDir,
			output: {
				dir: outDir,
			},
			dev: false,
			minify: false,
			rollupConfig: {
				plugins: [
					drizzleAirgap({
						searchDirectories: [path.resolve(__dirname, '../fixtures/schemas')],
						clientOnly: true, // Should skip interception in Nitro environment
					}),
				],
			},
		});

		process.env.NITRO_VERSION = '3.0.0';

		try {
			await prepare(nitro);
			await build(nitro);
		} finally {
			delete process.env.NITRO_VERSION;
		}

		const builtServerFile = path.resolve(outDir, 'server/index.mjs');
		expect(fs.existsSync(builtServerFile)).toBe(true);

		const routesChunkFile = path.resolve(outDir, 'server/_chunks/routes.mjs');
		expect(fs.existsSync(routesChunkFile)).toBe(true);

		const routesCode = fs.readFileSync(routesChunkFile, 'utf-8');

		// The plugin should skip interception:
		// 1. Shims are NOT injected
		expect(routesCode).not.toContain('drizzle-airgap-shim');
		expect(routesCode).not.toContain('buildZodSchema');

		// 2. Schema metadata is NOT transformed to plain metadata objects
		expect(routesCode).not.toContain('"kind": "table"');

		// 3. The route itself is successfully compiled
		expect(routesCode).toContain('defineEventHandler');
	});
});
