import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as globby from 'tinyglobby';
import { describe, it, expect, beforeAll } from 'vitest';

describe('Nuxt E2E Build Integration', () => {
	const nuxtAppDir = path.resolve(__dirname, '../fixtures/nuxt-app');
	const outputDir = path.resolve(__dirname, '../../test-artifacts/nuxt/.output');
	const nuxtDir = path.resolve(__dirname, '../../test-artifacts/nuxt/.nuxt');

	beforeAll(() => {
		// Clean previous build artifacts
		if (fs.existsSync(outputDir)) {
			fs.rmSync(outputDir, { recursive: true, force: true });
		}
		if (fs.existsSync(nuxtDir)) {
			fs.rmSync(nuxtDir, { recursive: true, force: true });
		}
	});

	it('should compile Nuxt app, intercepting client code but keeping server code original', async () => {
		// Run Nuxt build
		// Set process.env.NODE_ENV to production so Nuxt runs production build
		execSync('node --run build', {
			cwd: nuxtAppDir,
			env: {
				...process.env,
				NODE_ENV: 'production',
			},
			stdio: 'inherit',
		});

		// 1. Locate and inspect client-side bundles
		const clientJsFiles = await globby.glob('public/_nuxt/*.js', {
			cwd: outputDir,
			absolute: true,
		});

		expect(clientJsFiles.length).toBeGreaterThan(0);

		let clientCodeCombined = '';
		for (const file of clientJsFiles) {
			clientCodeCombined += fs.readFileSync(file, 'utf-8') + '\n';
		}

		// Client bundle must contain:
		// - Inlined schema metadata keys
		expect(clientCodeCombined).toContain('isActive');
		expect(clientCodeCombined).toContain('__meta');
		// - Virtual shim code
		expect(clientCodeCombined).toContain('buildZodSchema');
		// Client bundle must NOT contain:
		// - drizzle-orm references
		expect(clientCodeCombined).not.toContain('drizzle-orm');

		// 2. Locate and inspect server-side API chunk
		const serverApiFiles = await globby.glob('server/chunks/routes/api/user.mjs', {
			cwd: outputDir,
			absolute: true,
		});

		expect(serverApiFiles.length).toBe(1);

		const serverApiCode = fs.readFileSync(serverApiFiles[0], 'utf-8');

		// Server API must NOT contain:
		// - Virtual shim code (no interception)
		expect(serverApiCode).not.toContain('buildZodSchema');
		expect(serverApiCode).not.toContain('drizzle-airgap-shim');
		// Server API must contain:
		// - Original Drizzle schema references / code
		expect(serverApiCode).toContain('drizzle-orm');
	}, 30000);
});
