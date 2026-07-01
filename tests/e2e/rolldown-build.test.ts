import * as fs from 'node:fs';
import * as path from 'node:path';

import { rolldown } from 'rolldown';
import { describe, it, expect, beforeAll } from 'vitest';

import drizzleAirgap from '../../src/rolldown';

describe('Rolldown E2E Build', () => {
	beforeAll(() => {
		const artDir = path.resolve(__dirname, '../../test-artifacts/rolldown');
		if (fs.existsSync(artDir)) {
			fs.rmSync(artDir, { recursive: true, force: true });
		}
	});

	it('should compile consumer.ts and completely exclude drizzle-orm', async () => {
		const buildResult = await rolldown({
			input: path.resolve(__dirname, '../fixtures/consumer.ts'),
			plugins: [
				drizzleAirgap({
					searchDirectories: [path.resolve(__dirname, '../fixtures/schemas')],
					outputFilePath: path.resolve(__dirname, '../../test-artifacts/rolldown/validation.ts'),
					clientOnly: false,
				}),
			],
			external: ['zod'],
		});

		const result = await buildResult.generate({
			format: 'es',
			minify: false,
		});

		const chunk = result.output.find((o) => o.type === 'chunk');
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
});
