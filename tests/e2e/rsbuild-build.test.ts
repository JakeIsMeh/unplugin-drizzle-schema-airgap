import * as fs from 'node:fs';
import * as path from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import * as globby from 'tinyglobby';
import { describe, it, expect, beforeAll } from 'vitest';

import drizzleAirgap from '../../src/rsbuild';

describe('Rsbuild SSR & Client E2E Build', () => {
	const outputRoot = path.resolve(__dirname, '../../test-artifacts/rsbuild');

	beforeAll(() => {
		if (fs.existsSync(outputRoot)) {
			fs.rmSync(outputRoot, { recursive: true, force: true });
		}
	});

	it('should compile web and node targets, intercepting client code but keeping server code original', async () => {
		const rsbuild = await createRsbuild({
			rsbuildConfig: {
				environments: {
					web: {
						output: {
							target: 'web',
							distPath: {
								root: path.join(outputRoot, 'web'),
							},
						},
						source: {
							entry: {
								index: path.resolve(__dirname, '../fixtures/consumer.ts'),
							},
						},
					},
					node: {
						output: {
							target: 'node',
							distPath: {
								root: path.join(outputRoot, 'node'),
							},
						},
						source: {
							entry: {
								index: path.resolve(__dirname, '../fixtures/consumer.ts'),
							},
						},
					},
				},
				plugins: [
					drizzleAirgap({
						searchDirectories: [path.resolve(__dirname, '../fixtures/schemas')],
						clientOnly: true,
					}),
				],
				performance: {
					chunkSplit: {
						strategy: 'all-in-one',
					},
				},
				tools: {
					rspack: {
						optimization: {
							minimize: false, // Disable minimization for stable assertions
						},
						externals: {
							zod: 'module zod',
						},
					},
				},
			},
		});

		await rsbuild.build();

		// 1. Locate and inspect web (client) bundle
		const webJsFiles = await globby.glob('web/**/*.js', {
			cwd: outputRoot,
			absolute: true,
		});
		expect(webJsFiles.length).toBeGreaterThan(0);

		const webCode = fs.readFileSync(webJsFiles[0], 'utf-8');

		// Client bundle must contain inlined properties & shims
		expect(webCode).toContain('isActive');
		expect(webCode).toContain('__meta');
		expect(webCode).toContain('buildZodSchema');
		// Client bundle must NOT contain drizzle-orm
		expect(webCode).not.toContain('drizzle-orm');

		// 2. Locate and inspect node (SSR server) bundle
		const nodeJsFiles = await globby.glob('node/**/*.js', {
			cwd: outputRoot,
			absolute: true,
		});
		expect(nodeJsFiles.length).toBeGreaterThan(0);

		const nodeCode = fs.readFileSync(nodeJsFiles[0], 'utf-8');

		// Server bundle must NOT contain shims/interceptors
		expect(nodeCode).not.toContain('buildZodSchema');
		expect(nodeCode).not.toContain('drizzle-airgap-shim');
		// Server bundle must contain original drizzle-orm references
		expect(nodeCode).toContain('drizzle-orm');
	}, 20000);
});
