import { defineConfig } from 'vitest/config';

import drizzleAirgap from './src/vite';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.test.ts'],
				},
			},
			{
				plugins: [
					drizzleAirgap({
						searchDirectories: ['tests/fixtures/schemas'],
						outputFilePath: 'tests/fixtures/.generated/validation.ts',
						clientOnly: false,
					}),
				],
				test: {
					name: 'plugin',
					include: ['tests/plugin/**/*.test.ts'],
				},
			},
			{
				test: {
					name: 'e2e',
					include: ['tests/e2e/**/*.test.ts'],
				},
			},
		],
	},
});
