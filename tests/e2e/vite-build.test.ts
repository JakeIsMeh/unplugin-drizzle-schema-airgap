import * as fs from 'node:fs';
import * as path from 'node:path';

import { build } from 'vite';
import { describe, it, expect, beforeAll } from 'vitest';

import drizzleAirgap from '../../src/vite';

describe('Vite E2E Build', () => {
	beforeAll(() => {
		const artDir = path.resolve(__dirname, '../../test-artifacts/vite');
		if (fs.existsSync(artDir)) {
			fs.rmSync(artDir, { recursive: true, force: true });
		}
	});

	it('should compile consumer.ts and completely exclude drizzle-orm', async () => {
		const result = await build({
			root: path.resolve(__dirname, '../fixtures'),
			plugins: [
				drizzleAirgap({
					searchDirectories: [path.resolve(__dirname, '../fixtures/schemas')],
					outputFilePath: path.resolve(__dirname, '../../test-artifacts/vite/validation.ts'),
					clientOnly: false,
				}),
			],
			build: {
				write: false,
				minify: false, // Disable minification for stable assertions
				lib: {
					entry: path.resolve(__dirname, '../fixtures/consumer.ts'),
					formats: ['es'],
					fileName: 'consumer',
				},
				rollupOptions: {
					external: ['zod'], // Mark zod as external so rollup doesn't bundle it
				},
			},
		});

		const output = Array.isArray(result) ? result[0] : (result as any);
		const chunk = (output.output as any[]).find((o) => o.type === 'chunk');
		expect(chunk).toBeDefined();

		const code = chunk!.code;

		// 1. Assert output bundle code contains __meta (validation metadata was inlined)
		expect(code).toContain('__meta');
		expect(code).toContain('isActive');

		// 2. Assert output bundle code does NOT contain drizzle-orm imports
		expect(code).not.toContain('drizzle-orm');

		// 3. Assert output bundle code contains zod shim inlined
		expect(code).toContain('buildZodSchema');
	});

	it('should compile consumer.ts completely in-memory (virtual mode) when outputFilePath is omitted', async () => {
		const result = await build({
			root: path.resolve(__dirname, '../fixtures'),
			plugins: [
				drizzleAirgap({
					searchDirectories: [path.resolve(__dirname, '../fixtures/schemas')],
					clientOnly: false,
				}),
			],
			build: {
				write: false,
				minify: false,
				lib: {
					entry: path.resolve(__dirname, '../fixtures/consumer.ts'),
					formats: ['es'],
					fileName: 'consumer',
				},
				rollupOptions: {
					external: ['zod'],
				},
			},
		});

		const output = Array.isArray(result) ? result[0] : (result as any);
		const chunk = (output.output as any[]).find((o) => o.type === 'chunk');
		expect(chunk).toBeDefined();

		const code = chunk!.code;

		// 1. Assert output bundle code contains metadata inlined from the virtual module
		expect(code).toContain('__meta');
		expect(code).toContain('isActive');

		// 2. Assert output bundle code does NOT contain drizzle-orm imports
		expect(code).not.toContain('drizzle-orm');

		// 3. Assert output bundle code contains zod shim inlined
		expect(code).toContain('buildZodSchema');
	});
});
