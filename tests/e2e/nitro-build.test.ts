import * as fs from 'node:fs';
import * as path from 'node:path';

import { createNitro, build, prepare } from 'nitro/builder';
import { describe, it, expect, beforeAll } from 'vitest';

import drizzleAirgap from '../../src/rollup';

describe('Nitro E2E Build', () => {
	const outDir = path.resolve(__dirname, '../../test-artifacts/nitro');
	const buildDir = path.resolve(__dirname, '../../test-artifacts/nitro-build');
	const fixtureDir = path.resolve(__dirname, '../fixtures/nitro-app');

	beforeAll(() => {
		if (fs.existsSync(outDir)) {
			fs.rmSync(outDir, { recursive: true, force: true });
		}
		if (fs.existsSync(buildDir)) {
			fs.rmSync(buildDir, { recursive: true, force: true });
		}
	});

	it('should compile a Nitro project and NOT intercept schemas (due to server target)', async () => {
		const nitro = await createNitro({
			rootDir: fixtureDir,
			serverDir: fixtureDir,
			buildDir,
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

		// CI (Linux) compiles routes directly to `server/_routes/index.mjs`
		// Windows compiles routes to a general chunk at `server/_chunks/routes.mjs`
		const routesChunkFile = fs.existsSync(path.resolve(outDir, 'server/_routes/index.mjs'))
			? path.resolve(outDir, 'server/_routes/index.mjs')
			: path.resolve(outDir, 'server/_chunks/routes.mjs');

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
