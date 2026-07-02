import * as fs from 'node:fs';
import * as path from 'node:path';

import { build } from 'vite';
import { describe, it, expect, beforeAll } from 'vitest';

import drizzleAirgap from '../../src/vite';

describe('Airgap Suffix & Magic Comments E2E Build', () => {
	const artDir = path.resolve(__dirname, '../../test-artifacts/airgap');
	const tsconfigPath = path.resolve(process.cwd(), '.drizzle-airgap/tsconfig.json');
	const dtsFilePath = path.resolve(
		process.cwd(),
		'.drizzle-airgap/tests/fixtures/schemas/airgap-test.d.ts',
	);

	beforeAll(() => {
		if (fs.existsSync(artDir)) {
			fs.rmSync(artDir, { recursive: true, force: true });
		}
		const drizzleAirgapDir = path.resolve(process.cwd(), '.drizzle-airgap');
		if (fs.existsSync(drizzleAirgapDir)) {
			fs.rmSync(drizzleAirgapDir, { recursive: true, force: true });
		}
	});

	it('should compile airgap-consumer.ts, respecting magic pick/omit comments and resolving /airgap suffix', async () => {
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
					entry: path.resolve(__dirname, '../fixtures/airgap-consumer.ts'),
					formats: ['es'],
					fileName: 'airgap-consumer',
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

		// 1. Assert metadata was successfully generated and inlined
		expect(code).toContain('__meta');

		// 2. Assert omit directive worked (secretField stripped)
		expect(code).not.toContain('secretField');
		expect(code).not.toContain('secret_field');
		expect(code).toContain('name'); // name was NOT stripped

		// 3. Assert pick directive worked (only id and publicField kept, privateField stripped)
		expect(code).toContain('publicField');
		expect(code).not.toContain('privateField');
		expect(code).not.toContain('private_field');

		// 4. Assert drizzle-orm is completely excluded
		expect(code).not.toContain('drizzle-orm');

		// 5. Assert zod shim was inlined
		expect(code).toContain('buildZodSchema');

		// 6. Assert tsconfig.json paths mapping was generated
		expect(fs.existsSync(tsconfigPath)).toBe(true);
		const tsconfigJson = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
		expect(tsconfigJson.compilerOptions.paths).toBeDefined();
		expect(tsconfigJson.compilerOptions.paths['*tests/fixtures/schemas/airgap-test/airgap']).toBeDefined();

		// 7. Assert .d.ts declaration file was generated and uses custom types
		expect(fs.existsSync(dtsFilePath)).toBe(true);
		const dtsContent = fs.readFileSync(dtsFilePath, 'utf-8');
		expect(dtsContent).toContain('OmitColumns<typeof original.secretTable');
		expect(dtsContent).toContain('PickColumns<typeof original.publicTable');
	});

	it('should warn when client modules import raw schemas directly without /airgap suffix', async () => {
		let rawSchemaImportWarned = false;

		await build({
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
					entry: path.resolve(__dirname, '../fixtures/consumer.ts'), // Imports from './schemas' directly
					formats: ['es'],
					fileName: 'consumer',
				},
				rollupOptions: {
					external: ['zod', 'drizzle-orm', 'drizzle-orm/pg-core'],
					onwarn(warning, defaultWarn) {
						if (warning.message?.includes('Importing directly from raw schema')) {
							rawSchemaImportWarned = true;
						}
					},
				},
			},
		});

		expect(rawSchemaImportWarned).toBe(true);
	});
});
