import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/vite.ts',
		'src/rolldown.ts',
		'src/rollup.ts',
		'src/rspack.ts',
		'src/esbuild.ts',
		'src/webpack.ts',
		'src/rsbuild.ts',
		'src/farm.ts',
		'src/bun.ts',
	],
	format: ['esm', 'cjs'],
	dts: true,
	clean: true,
});
