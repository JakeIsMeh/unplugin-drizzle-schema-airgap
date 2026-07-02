/**
 * @file unplugin-drizzle-schema-airgap
 * @description Unplugin that airgaps your drizzle-derived validation schemas
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { createJiti } from 'jiti';
import { parse, parseSync } from 'oxc-parser';
import * as globby from 'tinyglobby';
import { createUnplugin } from 'unplugin';

import {
	type DrizzleColumn,
	generatePlainObject,
	getSerializedValue,
	hasCallToAny,
	resolveSpecifier,
	getValidatorShimCode,
} from './helpers';

/**
 * Options for the Drizzle Schema Airgap Plugin.
 */
export interface DrizzleSchemaAirgapOptions {
	/**
	 * Absolute or relative paths to directories containing your Drizzle schema files (e.g. ['./db']).
	 */
	searchDirectories: string[];
	/**
	 * The file path where the generated client-side validation metadata will be saved.
	 * Defaults to 'node_modules/.cache/drizzle-schema-airgap/validation.ts' to keep your source tree clean.
	 */
	outputFilePath?: string;
	/**
	 * If true (default), only intercepts client-side environments (Vite client target).
	 */
	clientOnly?: boolean;
	/**
	 * List of column names to completely strip from the client-side schema metadata (e.g. ['passwordHash', 'stripeId']).
	 */
	omitColumns?: string[];
}

const unplugin = createUnplugin<DrizzleSchemaAirgapOptions>((options, meta) => {
	const absoluteOutputPath = options.outputFilePath ? path.resolve(options.outputFilePath) : null;
	const clientOnly = options.clientOnly ?? true;
	const isRollupFamily = ['vite', 'rollup', 'rolldown'].includes(meta.framework);
	const VIRTUAL_PREFIX = isRollupFamily ? '\0virtual:' : 'virtual:';

	let isSSR = false;
	let webpackOrRspackCompiler: any = null;

	// Cache of generated validation schemas per file path for incremental HMR
	interface CachedSchema {
		name: string;
		code: string;
	}
	interface CachedFileResult {
		hash: string;
		schemas: CachedSchema[];
	}
	const fileCache = new Map<string, CachedFileResult>();

	// Map of normalized schema paths -> original file paths for resolveId lookup
	const schemaPathIndex = new Map<string, string>();

	interface Directive {
		type: 'pick' | 'omit';
		columns: Set<string>;
	}
	const fileStaticExports = new Map<string, any[]>();
	const fileLocalDirectives = new Map<string, Map<string, Directive>>();

	// Path aliases propagated to Jiti
	let aliases: Record<string, string> = {};

	// Prevents concurrent generation runs during rapid HMR file saves
	let pendingGeneration: Promise<void> | null = null;

	const activeFiles = new Set<string>();
	const referencedNames = new Set<string>();

	async function runScanAndGeneration() {
		const filePaths: string[] = [];
		// Scan target directories for schema files
		for (const searchDir of options.searchDirectories) {
			const absDir = path.resolve(searchDir);
			if (!fs.existsSync(absDir)) continue;

			const files = await globby.glob('**/*.{ts,js,mts,cts,tsx,jsx}', {
				cwd: absDir,
				absolute: true,
			});
			filePaths.push(...files);
		}

		activeFiles.clear();

		// Cache drizzle-orm modules across Jiti evaluations for performance
		const jiti = createJiti(process.cwd(), {
			alias: aliases,
		});

		for (const filePath of filePaths) {
			if (filePath === absoluteOutputPath) continue;

			let content: string;
			try {
				content = await fs.promises.readFile(filePath, 'utf-8');
			} catch {
				continue;
			}

			// Fast check to skip files without Drizzle imports
			if (!content.includes('drizzle-orm/')) {
				continue;
			}

			const hash = crypto.createHash('sha256').update(content).digest('hex');

			const cached = fileCache.get(filePath);
			if (cached && cached.hash === hash) {
				activeFiles.add(filePath);
				continue;
			}

			// Parse AST to find Drizzle imports
			let parseResult: ReturnType<typeof parseSync>;
			try {
				parseResult = await parse(filePath, content);
			} catch (err) {
				console.warn(`[drizzle-schema-airgap] Failed to parse schema file: ${filePath}`, err);
				continue;
			}

			const staticImports = parseResult.module?.staticImports || [];
			const drizzleImports = staticImports.filter((imp) =>
				imp.moduleRequest?.value?.includes('drizzle-orm'),
			);

			if (drizzleImports.length === 0) {
				fileCache.delete(filePath);
				fileStaticExports.delete(filePath);
				fileLocalDirectives.delete(filePath);
				continue;
			}

			const localBuilders = new Set<string>();

			for (const imp of drizzleImports) {
				for (const entry of imp.entries || []) {
					if (entry.localName?.value) {
						const localName = entry.localName.value;
						const originalName = entry.importName?.name;
						const isNamespace = entry.importName?.kind === 'NamespaceObject';

						if (isNamespace) {
							localBuilders.add(localName);
						} else if (originalName) {
							const knownBuilders = [
								'pgTable',
								'mysqlTable',
								'sqliteTable',
								'pgTableCreator',
								'mysqlTableCreator',
								'sqliteTableCreator',
								'pgView',
								'mysqlView',
								'sqliteView',
								'pgMaterializedView',
								'relations',
							];
							if (knownBuilders.includes(originalName)) {
								localBuilders.add(localName);
							}
						}
					}
				}
			}

			if (localBuilders.size === 0) {
				fileCache.delete(filePath);
				fileStaticExports.delete(filePath);
				fileLocalDirectives.delete(filePath);
				continue;
			}

			// Ensure builders are actually invoked in the AST (ignores string/comment matches)
			const isInvoked = hasCallToAny(parseResult.program, localBuilders);

			if (isInvoked) {
				activeFiles.add(filePath);
				fileStaticExports.set(filePath, parseResult.module?.staticExports || []);

				// Parse local directives
				const directives = new Map<string, Directive>();
				if (parseResult.comments) {
					for (const comment of parseResult.comments) {
						const val = comment.value;
						if (val.includes('@drizzle-airgap')) {
							const cleaned = val.replace('@drizzle-airgap', '').trim();
							const parts = cleaned.split(/\s+/);
							const action = parts[0];
							if (action === 'omit' || action === 'pick') {
								const cols = parts.slice(1)
									.join('')
									.split(',')
									.map(c => c.trim())
									.filter(Boolean);

								const directive: Directive = {
									type: action,
									columns: new Set(cols)
								};

								let closestNode: any = null;
								let minDiff = Infinity;

								for (const node of parseResult.program.body) {
									if (
										(node.type === 'ExportNamedDeclaration' && node.declaration) ||
										node.type === 'ExportDefaultDeclaration' ||
										node.type === 'VariableDeclaration'
									) {
										const diff = node.start - comment.end;
										if (diff >= 0 && diff < minDiff) {
											minDiff = diff;
											closestNode = node;
										}
									}
								}

								if (closestNode) {
									let declNode = closestNode;
									if (closestNode.type === 'ExportNamedDeclaration') {
										declNode = closestNode.declaration;
									}
									if (declNode.type === 'VariableDeclaration') {
										for (const decl of declNode.declarations || []) {
											if (decl.id && decl.id.name) {
												directives.set(decl.id.name, directive);
											}
										}
									} else if (closestNode.type === 'ExportDefaultDeclaration') {
										directives.set('default', directive);
									}
								}
							}
						}
					}
				}
				fileLocalDirectives.set(filePath, directives);

				const schemas: CachedSchema[] = [];
				try {
					const exports = (await jiti.import(filePath)) as Record<string, unknown>;
					const processedNames = new Set<string>();

					for (const [exportName, val] of Object.entries(exports)) {
						// Serialize pgEnum values as string arrays
						if (
							typeof val === 'function' &&
							'enumValues' in val &&
							Array.isArray((val as any).enumValues)
						) {
							const code = `export const ${exportName} = ${JSON.stringify((val as any).enumValues)};`;
							schemas.push({ name: exportName, code });
							processedNames.add(exportName);
							continue;
						}

						if (!val || typeof val !== 'object') continue;

						const isTable = Symbol.for('drizzle:IsDrizzleTable') in val;
						if (isTable) {
							const columns = (val as Record<symbol, Record<string, DrizzleColumn>>)[
								Symbol.for('drizzle:Columns')
							];
							const localFilter = directives.get(exportName);
							const filteredColumns: Record<string, DrizzleColumn> = {};
							for (const [colKey, col] of Object.entries(columns || {})) {
								let shouldInclude = true;
								if (localFilter) {
									if (localFilter.type === 'omit') {
										shouldInclude = !localFilter.columns.has(colKey);
									} else if (localFilter.type === 'pick') {
										shouldInclude = localFilter.columns.has(colKey);
									}
								}
								if (shouldInclude && options.omitColumns?.includes(colKey)) {
									shouldInclude = false;
								}
								if (shouldInclude) {
									filteredColumns[colKey] = col;
								}
							}
							const code = generatePlainObject(exportName, filteredColumns, 'table');
							schemas.push({ name: exportName, code });
							processedNames.add(exportName);
							continue;
						}

						const isView = Symbol.for('drizzle:IsDrizzleView') in val;
						if (isView) {
							const columns = (
								val as Record<symbol, { selectedFields: Record<string, DrizzleColumn> }>
							)[Symbol.for('drizzle:ViewBaseConfig')]?.selectedFields;
							const localFilter = directives.get(exportName);
							const filteredColumns: Record<string, DrizzleColumn> = {};
							for (const [colKey, col] of Object.entries(columns || {})) {
								let shouldInclude = true;
								if (localFilter) {
									if (localFilter.type === 'omit') {
										shouldInclude = !localFilter.columns.has(colKey);
									} else if (localFilter.type === 'pick') {
										shouldInclude = localFilter.columns.has(colKey);
									}
								}
								if (shouldInclude && options.omitColumns?.includes(colKey)) {
									shouldInclude = false;
								}
								if (shouldInclude) {
									filteredColumns[colKey] = col;
								}
							}
							const code = generatePlainObject(exportName, filteredColumns, 'view');
							schemas.push({ name: exportName, code });
							processedNames.add(exportName);
							continue;
						}
					}

					// Stub or serialize non-schema exports
					const staticExports = parseResult.module?.staticExports || [];
					for (const exp of staticExports) {
						for (const entry of exp.entries || []) {
							const isDefault = entry.exportName?.kind === 'Default';
							const name = isDefault ? 'default' : entry.exportName?.name;

							if (name && !processedNames.has(name)) {
								const val = exports[name];
								const serializedValue = getSerializedValue(val);

								let code: string;
								if (serializedValue === 'undefined' && val !== undefined) {
									// Fallback for unserializable values (functions, symbols, circular refs)
									const warn = `(import.meta.env.DEV && console.warn('[drizzle-schema-airgap] Export "${name}" could not be serialized for the client bundle and will be undefined.'), undefined)`;
									code = isDefault ? `export default ${warn};` : `export const ${name} = ${warn};`;
								} else {
									code = isDefault
										? `export default ${serializedValue};`
										: `export const ${name} = ${serializedValue};`;
								}
								schemas.push({ name, code });
								processedNames.add(name);
							}
						}
					}

					fileCache.set(filePath, { hash, schemas });
				} catch (err) {
					console.error(
						`[drizzle-schema-airgap] Failed to load/generate schema for file: ${filePath}`,
						err,
					);
					fileCache.delete(filePath);
					fileStaticExports.delete(filePath);
					fileLocalDirectives.delete(filePath);
				}
			} else {
				fileCache.delete(filePath);
				fileStaticExports.delete(filePath);
				fileLocalDirectives.delete(filePath);
			}
		}

		// Clean up cache of inactive files
		for (const cachedPath of fileCache.keys()) {
			if (!activeFiles.has(cachedPath)) {
				fileCache.delete(cachedPath);
				fileStaticExports.delete(cachedPath);
				fileLocalDirectives.delete(cachedPath);
			}
		}

		const allSchemas: CachedSchema[] = [];
		const exportedNames = new Set<string>();

		for (const filePath of activeFiles) {
			const cached = fileCache.get(filePath);
			if (cached) {
				for (const schema of cached.schemas) {
					if (exportedNames.has(schema.name)) {
						console.warn(
							`[drizzle-schema-airgap] Duplicate schema export name skipped: "${schema.name}" in ${filePath}`,
						);
						continue;
					}
					exportedNames.add(schema.name);
					allSchemas.push(schema);
				}
			}
		}

		schemaPathIndex.clear();
		for (const cachedPath of fileCache.keys()) {
			const normalized = cachedPath.replace(/\\/g, '/').replace(/\.[^/.]+$/, '');
			schemaPathIndex.set(normalized, cachedPath);
		}

		// ── Phase 2: Transitive barrel file discovery ──────────────────────────
		const allKnownFiles = new Map<string, string>();
		for (const fp of filePaths) {
			const normalizedFp = fp.replace(/\\/g, '/').replace(/\.[^/.]+$/, '');
			allKnownFiles.set(normalizedFp, fp);
		}

		// Build reverse edge map: targetNormalized → Set<sourceNormalized> for re-exports
		const reverseEdges = new Map<string, Set<string>>();

		for (const filePath of filePaths) {
			if (filePath === absoluteOutputPath) continue;
			if (activeFiles.has(filePath)) continue;

			let barrelContent: string;
			try {
				barrelContent = await fs.promises.readFile(filePath, 'utf-8');
			} catch {
				continue;
			}

			if (!barrelContent.includes('export')) continue;

			let barrelParse: ReturnType<typeof parseSync>;
			try {
				barrelParse = await parse(filePath, barrelContent);
			} catch {
				continue;
			}

			const fileDir = path.dirname(filePath);
			const sourceNorm = filePath.replace(/\\/g, '/').replace(/\.[^/.]+$/, '');
			const barrelExports = barrelParse.module?.staticExports || [];

			for (const exp of barrelExports) {
				for (const entry of exp.entries || []) {
					const specifier = entry.moduleRequest?.value;
					if (!specifier || !specifier.startsWith('.')) continue;

					const targetNorm = resolveSpecifier(fileDir, specifier, allKnownFiles);
					if (!targetNorm) continue;

					let sources = reverseEdges.get(targetNorm);
					if (!sources) {
						sources = new Set();
						reverseEdges.set(targetNorm, sources);
					}
					sources.add(sourceNorm);
				}
			}
		}

		// BFS to find parent barrel files
		const visited = new Set<string>();
		const queue: string[] = [];

		for (const schemaKey of schemaPathIndex.keys()) {
			visited.add(schemaKey);
			queue.push(schemaKey);
		}

		while (queue.length > 0) {
			const current = queue.shift()!;
			const sources = reverseEdges.get(current);
			if (!sources) continue;

			for (const source of sources) {
				if (visited.has(source)) continue;
				visited.add(source);

				const originalPath = allKnownFiles.get(source);
				if (originalPath) {
					schemaPathIndex.set(source, originalPath);
				}
				queue.push(source);
			}
		}

		// ── Phase 1.5: Reference scanning to prevent database structure leak ───
		referencedNames.clear();

		const projectFiles = await globby.glob('**/*.{ts,js,mts,cts,tsx,jsx,vue,svelte,astro,html}', {
			cwd: process.cwd(),
			ignore: [
				'**/node_modules/**',
				'**/.git/**',
				'**/.next/**',
				'**/.nuxt/**',
				'**/.astro/**',
				'**/dist/**',
				'**/test-artifacts/**',
				'**/.cache/**',
				'**/output/**',
				'**/.output/**',
				'**/.temp/**',
				'**/temp/**',
				'**/tmp/**',
				...options.searchDirectories.map(
					(dir) => `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/**`,
				),
			],
			absolute: true,
		});

		const schemaNames = Array.from(exportedNames);
		if (schemaNames.length > 0 && projectFiles.length > 0) {
			// Read files in parallel batches of 50 to avoid file descriptor limits
			const batchSize = 50;
			for (let i = 0; i < projectFiles.length; i += batchSize) {
				const batch = projectFiles.slice(i, i + batchSize);
				const contents = await Promise.all(
					batch.map(async (file) => {
						if (file === absoluteOutputPath) return '';
						try {
							return await fs.promises.readFile(file, 'utf-8');
						} catch {
							return '';
						}
					}),
				);

				for (const fileContent of contents) {
					if (!fileContent) continue;
					for (let j = schemaNames.length - 1; j >= 0; j--) {
						const name = schemaNames[j];
						if (fileContent.includes(name)) {
							referencedNames.add(name);
							schemaNames.splice(j, 1);
						}
					}
				}

				if (schemaNames.length === 0) break;
			}
		}

		const comment = `// Auto-generated by unplugin-drizzle-schema-airgap. Do not edit directly.\n\n`;
		const filteredSchemas = allSchemas.filter((s) => referencedNames.has(s.name));
		const schemaCodes = filteredSchemas.map((s) => s.code);
		const finalCode = comment + schemaCodes.join('\n\n') + '\n';

		if (absoluteOutputPath) {
			const dir = path.dirname(absoluteOutputPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			let existingCode = '';
			if (fs.existsSync(absoluteOutputPath)) {
				existingCode = fs.readFileSync(absoluteOutputPath, 'utf-8');
			}

			if (existingCode !== finalCode) {
				fs.writeFileSync(absoluteOutputPath, finalCode, 'utf-8');
			}
		}

		// ── Nuxt-Style tsconfig & .d.ts Generation ───────────────────────────
		const drizzleAirgapDir = path.resolve(process.cwd(), '.drizzle-airgap');
		if (!fs.existsSync(drizzleAirgapDir)) {
			fs.mkdirSync(drizzleAirgapDir, { recursive: true });
		}

		const paths: Record<string, string[]> = {};

		for (const filePath of activeFiles) {
			const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
			const relativePathNoExt = relativePath.replace(/\.[^/.]+$/, '');

			const sandboxedPath = relativePathNoExt
				.split('/')
				.map((segment) => (segment === '..' ? '_parent_' : segment))
				.join('/');

			const dtsRelativePath = `.drizzle-airgap/${sandboxedPath}.d.ts`;
			const dtsAbsoluteFile = path.resolve(process.cwd(), dtsRelativePath);
			const dtsDir = path.dirname(dtsAbsoluteFile);
			if (!fs.existsSync(dtsDir)) {
				fs.mkdirSync(dtsDir, { recursive: true });
			}

			const originalFileAbs = path.resolve(filePath);
			const relativeImportPath = path.relative(dtsDir, originalFileAbs)
				.replace(/\\/g, '/')
				.replace(/\.[^/.]+$/, '');

			const staticExports = fileStaticExports.get(filePath) || [];
			const fileDirectives = fileLocalDirectives.get(filePath) || new Map<string, Directive>();

			const header = `import type * as original from '${relativeImportPath}';

type OmitColumns<T, K extends string> = 
  T extends { _output: any; _input: any; shape: infer S }
    ? Omit<T, 'shape'> & { shape: Omit<S, K>; _output: Omit<T['_output'], K>; _input: Omit<T['_input'], K> }
    : T extends { entries: infer E; type: 'object' }
      ? Omit<T, 'entries'> & { entries: Omit<E, K> }
      : T;

type PickColumns<T, K extends string> = 
  T extends { _output: any; _input: any; shape: infer S }
    ? Omit<T, 'shape'> & { shape: Pick<S, K & keyof S>; _output: Pick<T['_output'], K & keyof T['_output']>; _input: Pick<T['_input'], K & keyof T['_input']> }
    : T extends { entries: infer E; type: 'object' }
      ? Omit<T, 'entries'> & { entries: Pick<E, K & keyof E> }
      : T;
`;

			const dtsExports: string[] = [];

			for (const exp of staticExports) {
				for (const entry of exp.entries || []) {
					const isDefault = entry.exportName?.kind === 'Default';
					const name = isDefault ? 'default' : entry.exportName?.name;
					if (!name) continue;

					const localFilter = fileDirectives.get(name);
					let mode: 'pick' | 'omit' = 'omit';
					let cols: string[] = [];

					if (localFilter) {
						mode = localFilter.type;
						cols = Array.from(localFilter.columns);
					} else if (options.omitColumns && options.omitColumns.length > 0) {
						mode = 'omit';
						cols = options.omitColumns;
					}

					const colsUnion = cols.length > 0
						? cols.map(c => `'${c}'`).join(' | ')
						: 'never';

					if (isDefault) {
						if (entry.isType) {
							dtsExports.push(`export type { default } from '${relativeImportPath}';`);
						} else {
							dtsExports.push(`declare const _default: ${mode === 'pick' ? 'PickColumns' : 'OmitColumns'}<typeof original.default, ${colsUnion}>;`);
							dtsExports.push(`export default _default;`);
						}
					} else {
						if (entry.isType) {
							dtsExports.push(`export type ${name} = original.${name};`);
						} else {
							dtsExports.push(`export declare const ${name}: ${mode === 'pick' ? 'PickColumns' : 'OmitColumns'}<typeof original.${name}, ${colsUnion}>;`);
						}
					}
				}
			}

			const dtsContent = header + '\n' + dtsExports.join('\n') + '\n';

			let existingDts = '';
			if (fs.existsSync(dtsAbsoluteFile)) {
				existingDts = fs.readFileSync(dtsAbsoluteFile, 'utf-8');
			}
			if (existingDts !== dtsContent) {
				fs.writeFileSync(dtsAbsoluteFile, dtsContent, 'utf-8');
			}

			paths[`*${relativePathNoExt}/airgap`] = [`./${sandboxedPath}.d.ts`].map(p => p.replace(/\\/g, '/'));
			paths[`${relativePathNoExt}/airgap`] = [`./${sandboxedPath}.d.ts`].map(p => p.replace(/\\/g, '/'));
		}

		const tsconfigPath = path.resolve(drizzleAirgapDir, 'tsconfig.json');
		const tsconfigContent = JSON.stringify({
			compilerOptions: {
				paths
			}
		}, null, 2) + '\n';

		let existingTsconfig = '';
		if (fs.existsSync(tsconfigPath)) {
			existingTsconfig = fs.readFileSync(tsconfigPath, 'utf-8');
		}
		if (existingTsconfig !== tsconfigContent) {
			fs.writeFileSync(tsconfigPath, tsconfigContent, 'utf-8');
		}
	}

	function isClientTarget(context: any, hookOptions?: any): boolean {
		if (!clientOnly) return true;

		// Skip interception on SSR builds (like Nuxt server-side/Nitro target)
		if (isSSR || hookOptions?.ssr) {
			return false;
		}

		if (process.env.NITRO_PRESET || process.env.NITRO_VERSION) {
			return false;
		}

		if (meta.framework === 'vite' && context.environment && context.environment.name !== 'client') {
			return false;
		}

		// Retrieve Rspack/Webpack target from native build context (supported by unplugin)
		if (context && typeof context.getNativeBuildContext === 'function') {
			try {
				const nativeContext = context.getNativeBuildContext();
				if (nativeContext) {
					if (nativeContext.framework === 'webpack' || nativeContext.framework === 'rspack') {
						const target = nativeContext.compiler?.options?.target;
						if (target === 'node' || (Array.isArray(target) && target.includes('node'))) {
							return false;
						}
						const loaderTarget = nativeContext.loaderContext?.target;
						if (
							loaderTarget === 'node' ||
							(Array.isArray(loaderTarget) && loaderTarget.includes('node'))
						) {
							return false;
						}
					}
				}
			} catch {
				// Fallback
			}
		}

		// Webpack / Rspack compiler options target check (always available in hooks)
		const compiler =
			webpackOrRspackCompiler || (meta as any).webpack?.compiler || (meta as any).rspack?.compiler;
		if (compiler) {
			const target = compiler.options?.target;
			if (target === 'node' || (Array.isArray(target) && target.includes('node'))) {
				return false;
			}
		}

		// Skip Webpack / Rspack node targets (loader context fallback)
		if (
			context &&
			(context.target === 'node' ||
				(Array.isArray(context.target) && context.target.includes('node')))
		) {
			return false;
		}

		return true;
	}

	return {
		name: 'unplugin-drizzle-schema-airgap',
		enforce: 'pre',

		async buildStart() {
			await runScanAndGeneration();
		},

		resolveId(source, importer, options) {
			if (!isClientTarget(this, options)) {
				return null;
			}

			// 1. Intercept drizzle-validator library imports and redirect to our virtual shim
			let isValidator = false;
			let lib: string | null = null;

			if (source.startsWith('drizzle-orm/')) {
				const sub = source.substring('drizzle-orm/'.length);
				if (['zod', 'valibot', 'typebox', 'effect', 'effect-schema', 'arktype'].includes(sub)) {
					isValidator = true;
					lib = sub === 'effect-schema' ? 'effect' : sub;
				} else {
					const coreSubpaths = ['pg-core', 'mysql-core', 'sqlite-core', 'singlestore-core'];
					if (!coreSubpaths.some((core) => sub.startsWith(core))) {
						const validatorSuspects = ['superstruct', 'joi', 'yup', 'runtypes', 'myzod', 'schema'];
						if (validatorSuspects.some((sus) => sub.includes(sus))) {
							console.warn(
								`[drizzle-schema-airgap] Warning: Drizzle validation subpath "${source}" is not supported. Supported libraries are zod, valibot, typebox, effect, and arktype.`,
							);
						}
					}
				}
			} else if (source.startsWith('drizzle-')) {
				const sub = source.substring('drizzle-'.length);
				if (['zod', 'valibot', 'typebox', 'effect', 'arktype'].includes(sub)) {
					isValidator = true;
					lib = sub;
				} else if (sub !== 'orm' && sub !== 'kit' && sub !== 'graphql') {
					console.warn(
						`[drizzle-schema-airgap] Warning: Drizzle validation package "${source}" is not supported. Supported libraries are zod, valibot, typebox, effect, and arktype.`,
					);
				}
			}

			if (isValidator && lib) {
				if (['zod', 'valibot', 'typebox', 'effect', 'arktype'].includes(lib)) {
					const libPackageMap: Record<string, string> = {
						zod: 'zod',
						valibot: 'valibot',
						typebox: '@sinclair/typebox',
						effect: '@effect/schema/Schema',
						arktype: 'arktype',
					};
					const pkgName = libPackageMap[lib];
					let resolvedPath = pkgName;
					if (importer) {
						try {
							const basePkg = pkgName.includes('/')
								? pkgName
										.split('/')
										.slice(0, pkgName.startsWith('@') ? 2 : 1)
										.join('/')
								: pkgName;
							const esmRequire = createRequire(importer);
							const pkgJsonPath = esmRequire.resolve(basePkg + '/package.json');
							const pkgDir = path.dirname(pkgJsonPath).replace(/\\/g, '/');
							resolvedPath = pkgName.replace(basePkg, pkgDir);
						} catch {
							// Fallback
						}
					}
					return `${VIRTUAL_PREFIX}drizzle-airgap-shim:${lib}?${resolvedPath}`;
				}
			}

			// 2. Intercept active schema file imports
			if (importer && schemaPathIndex.size > 0) {
				const isAirgapSuffix = source.endsWith('/airgap');
				const baseSource = isAirgapSuffix ? source.substring(0, source.length - '/airgap'.length) : source;

				let resolvedPath = baseSource.replace(/\\/g, '/');
				if (!path.isAbsolute(resolvedPath)) {
					resolvedPath = path.resolve(path.dirname(importer), baseSource).replace(/\\/g, '/');
				}
				const resolvedPathNoExt = resolvedPath.replace(/\.[^/.]+$/, '');

				let targetPathNoExt: string | null = null;
				if (schemaPathIndex.has(resolvedPathNoExt)) {
					targetPathNoExt = resolvedPathNoExt;
				} else {
					const asIndex = resolvedPathNoExt + '/index';
					if (schemaPathIndex.has(asIndex)) {
						targetPathNoExt = asIndex;
					}
				}

				if (targetPathNoExt) {
					const originalPath = schemaPathIndex.get(targetPathNoExt);
					if (isAirgapSuffix) {
						return `${VIRTUAL_PREFIX}drizzle-schema-airgap:file:${targetPathNoExt}`;
					} else if (absoluteOutputPath) {
						// Redirect to the physical output file
						return absoluteOutputPath;
					} else if (originalPath && activeFiles.has(originalPath)) {
						// Redirect to a unique in-memory virtual module for this file
						return `${VIRTUAL_PREFIX}drizzle-schema-airgap:file:${targetPathNoExt}`;
					}
				}
			}
			return null;
		},

		load(id) {
			if (!isClientTarget(this)) {
				return null;
			}

			// Load our virtual validator shim dynamically depending on the requested library
			if (id.startsWith(VIRTUAL_PREFIX + 'drizzle-airgap-shim:')) {
				const parts = id.substring((VIRTUAL_PREFIX + 'drizzle-airgap-shim:').length).split('?');
				const lib = parts[0];
				const resolvedPath = parts[1] || lib;
				return getValidatorShimCode(lib, resolvedPath);
			}

			// Load our virtual schema module
			if (id.startsWith(VIRTUAL_PREFIX + 'drizzle-schema-airgap:file:')) {
				const targetPathNoExt = id.substring(
					(VIRTUAL_PREFIX + 'drizzle-schema-airgap:file:').length,
				);
				const originalPath = schemaPathIndex.get(targetPathNoExt);
				if (originalPath) {
					const cached = fileCache.get(originalPath);
					if (cached) {
						const schemaCodes = cached.schemas
							.filter((s) => referencedNames.has(s.name))
							.map((s) => s.code);
						return schemaCodes.join('\n\n') + '\n';
					}
				}
				return '';
			}

			return null;
		},

		transform(code, id) {
			if (!isClientTarget(this)) {
				return null;
			}

			const hasPossibleSchemaImport = Array.from(schemaPathIndex.keys()).some((schemaKey) => {
				const lastPart = schemaKey.split('/').pop();
				return lastPart && code.includes(lastPart);
			});

			if (!hasPossibleSchemaImport) {
				return null;
			}

			try {
				const parseResult = parseSync(id, code);
				const imports = parseResult.module?.staticImports || [];
				for (const imp of imports) {
					const specifier = imp.moduleRequest?.value;
					if (specifier && !specifier.endsWith('/airgap')) {
						const resolved = path.resolve(path.dirname(id), specifier).replace(/\\/g, '/');
						const resolvedNoExt = resolved.replace(/\.[^/.]+$/, '');

						if (schemaPathIndex.has(resolvedNoExt) || schemaPathIndex.has(resolvedNoExt + '/index')) {
							const message =
								`[drizzle-schema-airgap] Warning in "${id}":\n` +
								`Importing directly from raw schema "${specifier}" in a client module will bundle the entire Drizzle ORM and all raw/sensitive columns.\n` +
								`Please use the airgapped suffix instead:\n` +
								`  "${specifier}/airgap"`;
							if (typeof this.warn === 'function') {
								this.warn(message);
							} else {
								console.warn(message);
							}
						}
					}
				}
			} catch {
				// Ignore parse errors for external/non-JS files
			}

			return null;
		},

		async watchChange(id) {
			const absoluteFile = path.resolve(id);

			if (absoluteOutputPath && absoluteFile === absoluteOutputPath) {
				return;
			}

			const inSearchDirs = options.searchDirectories.some((dir) => {
				const absDir = path.resolve(dir) + path.sep;
				return absoluteFile.startsWith(absDir);
			});

			if (inSearchDirs) {
				pendingGeneration ??= runScanAndGeneration().finally(() => {
					pendingGeneration = null;
				});
				await pendingGeneration;
			}
		},

		vite: {
			configResolved(resolvedConfig) {
				isSSR = !!resolvedConfig.build?.ssr;

				// Propagate resolved Vite path aliases to Jiti
				const aliasOption = resolvedConfig.resolve?.alias;
				if (aliasOption) {
					if (Array.isArray(aliasOption)) {
						for (const entry of aliasOption) {
							if (typeof entry.find === 'string') {
								aliases[entry.find] = entry.replacement;
							}
						}
					} else {
						for (const [find, replacement] of Object.entries(aliasOption)) {
							if (typeof replacement === 'string') {
								aliases[find] = replacement;
							}
						}
					}
				}
			},
			async handleHotUpdate({ file }) {
				const absoluteFile = path.resolve(file);

				if (absoluteOutputPath && absoluteFile === absoluteOutputPath) {
					return;
				}

				const inSearchDirs = options.searchDirectories.some((dir) => {
					const absDir = path.resolve(dir) + path.sep;
					return absoluteFile.startsWith(absDir);
				});

				if (inSearchDirs) {
					pendingGeneration ??= runScanAndGeneration().finally(() => {
						pendingGeneration = null;
					});
					await pendingGeneration;
				}
			},
		},
		webpack(compiler) {
			webpackOrRspackCompiler = compiler;
		},
		rspack(compiler) {
			webpackOrRspackCompiler = compiler;
		},
	};
});

export default unplugin;
