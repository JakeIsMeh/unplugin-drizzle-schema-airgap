import path from 'node:path';

import drizzleAirgap from '../../../src/vite';

export default defineNuxtConfig({
	compatibilityDate: '2026-07-01',
	ssr: true,
	buildDir: path.resolve(__dirname, '../../../test-artifacts/nuxt/.nuxt'),
	nitro: {
		minify: false,
		output: {
			dir: path.resolve(__dirname, '../../../test-artifacts/nuxt/.output'),
		},
	},
	vite: {
		plugins: [
			drizzleAirgap({
				searchDirectories: [path.resolve(__dirname, '../schemas')],
				clientOnly: true,
			}),
		],
		build: {
			minify: false,
		},
	},
});
