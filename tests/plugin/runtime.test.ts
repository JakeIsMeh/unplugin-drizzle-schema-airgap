import * as fs from 'node:fs';
import * as path from 'node:path';

// import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { type } from 'arktype';
// @ts-ignore
import { createSelectSchema as createSelectArkTypeSchema } from 'drizzle-orm/arktype';
import { createSelectSchema as createSelectTypeBoxSchema } from 'drizzle-orm/typebox';
import { createSelectSchema as createSelectValibotSchema } from 'drizzle-orm/valibot';
import { createSelectSchema, createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { Elysia, t } from 'elysia';
import * as v from 'valibot';
import { describe, it, expect } from 'vitest';

import unplugin from '../../src/plugin';
import { usersTable, userRoleEnum, postsTable, usersView } from '../fixtures/schemas';

// doesn't work, told elysia to use typebox for the normalizer instead
// (globalThis as any).TypeCompiler = TypeCompiler;

describe('Plugin Runtime - Metadata Schema Interception', () => {
	it('should intercept usersTable and return a plain object instead of a Drizzle Table', () => {
		expect(usersTable).toBeTypeOf('object');
		expect((usersTable as any).__meta).toBeDefined();
		expect((usersTable as any).__meta.kind).toBe('table');
		expect((usersTable as any).id.dataType).toContain('number');
		expect((usersTable as any).id.notNull).toBe(true);

		// Check properties for casing support without exposing database-specific internals
		expect((usersTable as any).isActive).toEqual({
			dataType: 'boolean',
			notNull: true,
			hasDefault: true,
		});
	});

	it('should intercept standalone pgEnum and export it as a string array', () => {
		// Original userRoleEnum is a Drizzle enum function, but should be intercepted as ['admin', 'user', 'guest']
		expect(userRoleEnum).toBeInstanceOf(Array);
		expect(userRoleEnum).toEqual(['admin', 'user', 'guest']);
	});

	it('should intercept usersView and return view metadata', () => {
		expect(usersView).toBeTypeOf('object');
		expect((usersView as any).__meta.kind).toBe('view');
	});

	it('should support transitive barrel exports (index.ts)', () => {
		expect(postsTable).toBeTypeOf('object');
		expect((postsTable as any).title).toEqual({ dataType: 'string', notNull: true });
	});
});

describe('Plugin Runtime - Zod Shims', () => {
	it('should redirect drizzle-zod to the virtual shim', () => {
		expect(createSelectSchema).toBeTypeOf('function');
		expect(createInsertSchema).toBeTypeOf('function');
		expect(createUpdateSchema).toBeTypeOf('function');
	});

	it('should generate valid select schema and validate data', () => {
		const selectSchema = createSelectSchema(usersTable);

		const validData = {
			id: 1,
			name: 'Alice',
			role: 'admin',
			isActive: true,
			metadata: { lastLogin: '2026-07-01', tags: ['vip'] },
		};

		const parsed = selectSchema.safeParse(validData);
		expect(parsed.success).toBe(true);

		const invalidData = {
			id: 'not-a-number',
			name: 'Alice',
		};
		const parsedInvalid = selectSchema.safeParse(invalidData);
		expect(parsedInvalid.success).toBe(false);
	});

	it('should enforce JSON record check for metadata column', () => {
		const selectSchema = createSelectSchema(usersTable);

		// metadata is marked as isJson: true, shim maps it to z.record(z.string(), z.unknown())
		const validWithJson = selectSchema.safeParse({
			id: 2,
			name: 'Bob',
			isActive: false,
			metadata: { key: 'value' },
		});
		expect(validWithJson.success).toBe(true);

		const invalidWithJson = selectSchema.safeParse({
			id: 2,
			name: 'Bob',
			isActive: false,
			metadata: 'should-be-an-object', // record expects an object
		});
		expect(invalidWithJson.success).toBe(false);
	});

	it('should throw when creating insert schema on a view', () => {
		expect(() => createInsertSchema(usersView as any)).toThrow(
			'[drizzle-schema-airgap] Cannot create insert schema for a view',
		);
	});
});

describe('Plugin Runtime - Valibot Shims', () => {
	it('should generate valid Valibot schema and validate data', () => {
		const valibotSchema = createSelectValibotSchema(usersTable);

		const validData = {
			id: 1,
			name: 'Alice',
			role: 'admin' as const,
			isActive: true,
			metadata: { lastLogin: '2026-07-01', tags: ['vip'] },
		};

		const parsed = v.safeParse(valibotSchema, validData);
		expect(parsed.success).toBe(true);

		const invalidData = {
			id: 'not-a-number',
			name: 'Alice',
		};
		const parsedInvalid = v.safeParse(valibotSchema, invalidData);
		expect(parsedInvalid.success).toBe(false);
	});
});

describe('Plugin Runtime - TypeBox Shims & Elysia', () => {
	it('should generate valid TypeBox schema and validate data', () => {
		const typeBoxSchema = createSelectTypeBoxSchema(usersTable);

		const validData = {
			id: 1,
			name: 'Alice',
			role: 'admin',
			isActive: true,
			metadata: { lastLogin: '2026-07-01', tags: ['vip'] },
		};

		expect(Value.Check(typeBoxSchema, validData)).toBe(true);

		const invalidData = {
			id: 'not-a-number',
			name: 'Alice',
		};
		expect(Value.Check(typeBoxSchema, invalidData)).toBe(false);
	});

	it('should interact correctly with Elysia request validation', async () => {
		const typeBoxSchema = createSelectTypeBoxSchema(usersTable as any);
		const app = new Elysia({
			normalize: 'typebox', //exact-mirror can't run within vitest
		}).post('/user', ({ body }) => body, {
			body: typeBoxSchema,
		});

		const response = await app.handle(
			new Request('http://localhost/user', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: 1,
					name: 'Elysia User',
					role: 'admin',
					isActive: true,
					metadata: { lastLogin: '2026-07-01', tags: [] },
				}),
			}),
		);
		expect(response.status).toBe(200);

		const badResponse = await app.handle(
			new Request('http://localhost/user', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: 'bad-id',
					name: 'Elysia User',
				}),
			}),
		);
		expect(badResponse.status).toBe(422); // Validation error
	});

	it('should support Elysia-only validators (t.File, t.Numeric) in overrides', async () => {
		// Override 'id' with t.Numeric() and add 'avatar' as t.File()
		const elysiaSchema = createSelectTypeBoxSchema(
			usersTable as any,
			{
				id: t.Numeric(),
				avatar: t.File(),
				isActive: t.Any(), // Bypass strict boolean check for FormData
			} as any,
		);

		const app = new Elysia({
			normalize: 'typebox', //exact-mirror can't run within vitest
		}).post('/upload', ({ body }) => body, {
			body: elysiaSchema,
		});

		const formData = new FormData();
		formData.append('id', '42'); // numeric string, should be coerced to number 42
		formData.append('name', 'John Doe');
		formData.append('role', 'user');
		formData.append('isActive', 'true');
		formData.append('metadata', JSON.stringify({ lastLogin: '2026-07-01', tags: [] }));

		const file = new File(['file content'], 'avatar.png', { type: 'image/png' });
		formData.append('avatar', file);

		const response = await app.handle(
			new Request('http://localhost/upload', {
				method: 'POST',
				body: formData,
			}),
		);

		if (response.status !== 200) {
			console.log('Elysia Error Body:', await response.text());
		}
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.id).toBe(42); // Coerced successfully to number!
		expect(json.avatar).toBeDefined();
	});
});

describe('Plugin Hooks - Guards & Warnings', () => {
	it('should warn when an unsupported validator package (like drizzle-superstruct) is resolved', () => {
		const pluginInstance = unplugin.raw(
			{
				searchDirectories: [],
				clientOnly: false,
			},
			{ framework: 'vite' } as any,
		) as any;

		const originalWarn = console.warn;
		let warnedMessage = '';
		console.warn = (msg) => {
			warnedMessage = msg;
		};

		try {
			const result = pluginInstance.resolveId!.call(
				{} as any,
				'drizzle-superstruct',
				undefined,
				{} as any,
			);
			expect(result).toBeNull(); // Guard returns null so standard package resolution proceeds
			expect(warnedMessage).toContain(
				'Warning: Drizzle validation package "drizzle-superstruct" is not supported',
			);
		} finally {
			console.warn = originalWarn;
		}
	});

	it('should warn when an unsupported validator subpath (like drizzle-orm/superstruct) is resolved', () => {
		const pluginInstance = unplugin.raw(
			{
				searchDirectories: [],
				clientOnly: false,
			},
			{ framework: 'vite' } as any,
		) as any;

		const originalWarn = console.warn;
		let warnedMessage = '';
		console.warn = (msg) => {
			warnedMessage = msg;
		};

		try {
			const result = pluginInstance.resolveId!.call(
				{} as any,
				'drizzle-orm/superstruct',
				undefined,
				{} as any,
			);
			expect(result).toBeNull();
			expect(warnedMessage).toContain(
				'Warning: Drizzle validation subpath "drizzle-orm/superstruct" is not supported',
			);
		} finally {
			console.warn = originalWarn;
		}
	});

	it('should resolve all supported validator subpaths and standalone packages successfully', () => {
		const pluginInstance = unplugin.raw(
			{
				searchDirectories: [],
				clientOnly: false,
			},
			{ framework: 'vite' } as any,
		) as any;

		const cases = [
			{ input: 'drizzle-orm/zod', expected: 'drizzle-airgap-shim:zod' },
			{ input: 'drizzle-orm/valibot', expected: 'drizzle-airgap-shim:valibot' },
			{ input: 'drizzle-orm/typebox', expected: 'drizzle-airgap-shim:typebox' },
			{ input: 'drizzle-orm/effect', expected: 'drizzle-airgap-shim:effect' },
			{ input: 'drizzle-orm/effect-schema', expected: 'drizzle-airgap-shim:effect' },
			{ input: 'drizzle-orm/arktype', expected: 'drizzle-airgap-shim:arktype' },
			{ input: 'drizzle-zod', expected: 'drizzle-airgap-shim:zod' },
			{ input: 'drizzle-valibot', expected: 'drizzle-airgap-shim:valibot' },
			{ input: 'drizzle-typebox', expected: 'drizzle-airgap-shim:typebox' },
			{ input: 'drizzle-effect', expected: 'drizzle-airgap-shim:effect' },
			{ input: 'drizzle-arktype', expected: 'drizzle-airgap-shim:arktype' },
		];

		for (const c of cases) {
			const result = pluginInstance.resolveId!.call({} as any, c.input, undefined, {} as any);
			expect(result).toBeDefined();
			expect(result).toContain(c.expected);
		}
	});

	it('should skip schema interception in a Nitro v3 project (server builds)', () => {
		const pluginInstance = unplugin.raw(
			{
				searchDirectories: [],
				clientOnly: true,
			},
			{ framework: 'rollup' } as any,
		) as any;

		process.env.NITRO_VERSION = '3.0.0';

		try {
			const result = pluginInstance.resolveId!.call({} as any, 'drizzle-zod', undefined, {} as any);
			expect(result).toBeNull(); // Shims resolution skipped
		} finally {
			delete process.env.NITRO_VERSION;
		}
	});

	it('should skip schema interception for Webpack/Rspack node compilation targets', () => {
		const pluginInstance = unplugin.raw(
			{
				searchDirectories: [],
				clientOnly: true,
			},
			{ framework: 'webpack' } as any,
		) as any;

		const result = pluginInstance.resolveId!.call(
			{ target: 'node' } as any,
			'drizzle-zod',
			undefined,
			{} as any,
		);
		expect(result).toBeNull(); // Shims resolution skipped
	});
});

describe('Plugin Runtime - ArkType Shims', () => {
	it('should generate valid ArkType select schema and validate data', () => {
		const arkTypeSchema = createSelectArkTypeSchema(usersTable);

		const validData = {
			id: 1,
			name: 'Alice',
			role: 'admin',
			isActive: true,
			metadata: { lastLogin: '2026-07-01', tags: ['vip'] },
		};

		const result = arkTypeSchema(validData);
		expect(result instanceof type.errors).toBe(false);

		const invalidData = {
			id: 'not-a-number',
			name: 'Alice',
		};
		const resultInvalid = arkTypeSchema(invalidData);
		expect(resultInvalid instanceof type.errors).toBe(true);
	});
	it('should support overrides in ArkType schema', () => {
		const arkTypeSchema = createSelectArkTypeSchema(
			usersTable as any,
			{
				id: type('number'),
				avatar: type('string'),
			} as any,
		);

		const validData = {
			id: 42,
			name: 'Bob',
			role: 'user',
			isActive: false,
			metadata: { lastLogin: '2026-07-01', tags: [] },
			avatar: 'my-avatar-path',
		};

		const result = arkTypeSchema(validData);
		expect(result instanceof type.errors).toBe(false);
	});
});

describe('Plugin Runtime - Reflected Schema Inspection', () => {
	it('should output the reflected virtual schema modules to test-artifacts/reflected-schemas', async () => {
		const targetDir = path.resolve(__dirname, '../../test-artifacts/reflected-schemas');
		if (fs.existsSync(targetDir)) {
			fs.rmSync(targetDir, { recursive: true, force: true });
		}
		fs.mkdirSync(targetDir, { recursive: true });

		const pluginInstance = unplugin.raw(
			{
				searchDirectories: [path.resolve(__dirname, '../fixtures/schemas')],
				clientOnly: false,
			},
			{ framework: 'vite' } as any,
		) as any;

		await pluginInstance.buildStart({} as any);

		// Reflect each schema file discovered in the fixtures/schemas directory
		const schemaFiles = fs
			.readdirSync(path.resolve(__dirname, '../fixtures/schemas'))
			.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

		for (const schemaFile of schemaFiles) {
			const schemaPath = path.resolve(
				__dirname,
				'../fixtures/schemas',
				schemaFile.replace(/\.ts$/, ''),
			);
			const normalised = schemaPath.replace(/\\/g, '/');
			const virtualId = pluginInstance.resolveId(
				normalised,
				path.resolve(__dirname, '../fixtures/consumer.ts'),
				{} as any,
			);
			if (virtualId) {
				const code = pluginInstance.load(virtualId as string);
				if (code) {
					const outName = schemaFile.replace(/\.ts$/, '.reflected.ts');
					fs.writeFileSync(path.join(targetDir, outName), code as string);
				}
			}
		}

		// Verify at least one reflected schema was written
		const written = fs.readdirSync(targetDir);
		expect(written.length).toBeGreaterThan(0);

		// Verify leak prevention:
		// 1. usersTable (referenced in tests) is present in users.reflected.ts
		const usersReflected = fs.readFileSync(path.join(targetDir, 'users.reflected.ts'), 'utf-8');
		expect(usersReflected).toContain('export const usersTable =');

		// 2. The unused table (not imported/used in codebase) is omitted from users.reflected.ts
		const dynamicUnreferencedTableName = 'unreferenced' + 'Table';
		expect(usersReflected).not.toContain(dynamicUnreferencedTableName);
	});
});

describe('Plugin Options - omitColumns', () => {
	it('should completely strip columns matching the omitColumns option from the generated schema metadata', async () => {
		const pluginInstance = unplugin.raw(
			{
				searchDirectories: [path.resolve(__dirname, '../fixtures/schemas')],
				clientOnly: false,
				omitColumns: ['isActive', 'metadata'],
			},
			{ framework: 'vite' } as any,
		) as any;

		await pluginInstance.buildStart({} as any);

		const schemaPath = path.resolve(__dirname, '../fixtures/schemas/users');
		const normalised = schemaPath.replace(/\\/g, '/');
		const virtualId = pluginInstance.resolveId(
			normalised,
			path.resolve(__dirname, '../fixtures/consumer.ts'),
			{} as any,
		);
		expect(virtualId).toBeDefined();

		const code = pluginInstance.load(virtualId as string);
		expect(code).toBeDefined();
		expect(code).toContain('export const usersTable =');

		// Columns specified in omitColumns should not be present in the generated code
		expect(code).not.toContain('isActive');
		expect(code).not.toContain('metadata');

		// Columns not specified in omitColumns should still be present
		expect(code).toContain('id');
		expect(code).toContain('name');
		expect(code).toContain('role');
	});
});
