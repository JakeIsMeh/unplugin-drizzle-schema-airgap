import * as path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
	generatePlainObject,
	getSerializedValue,
	resolveSpecifier,
	hasCallToAny,
	type DrizzleColumn,
} from '../../src/helpers';

describe('generatePlainObject', () => {
	it('should generate table metadata correctly', () => {
		const columns: Record<string, DrizzleColumn> = {
			id: { name: 'id', dataType: 'number', columnType: 'integer', notNull: true },
			name: { name: 'name', dataType: 'string', columnType: 'varchar', notNull: false },
		};

		const code = generatePlainObject('users', columns, 'table');
		expect(code).toContain('__meta: {"kind":"table"}');
		expect(code).toContain('id: {"dataType":"number","notNull":true}');
		expect(code).toContain('name: {"dataType":"string","notNull":false}');
	});

	it('should include isUuid for uuid columns', () => {
		const columns: Record<string, DrizzleColumn> = {
			id: { name: 'id', dataType: 'string', columnType: 'uuid', notNull: true },
			name: { name: 'name', dataType: 'string', columnType: 'varchar', notNull: true },
		};

		const code = generatePlainObject('users', columns, 'table');
		expect(code).toContain('"isUuid":true');
		expect(code).not.toContain('name: {"dataType":"string","notNull":true,"isUuid":true}');
	});

	it('should flag isJson for json/jsonb columns', () => {
		const columns: Record<string, DrizzleColumn> = {
			meta: { name: 'meta', dataType: 'json', columnType: 'json', notNull: false },
			blobMeta: { name: 'blobMeta', dataType: 'blob', columnType: 'json_blob', notNull: false },
		};

		const code = generatePlainObject('users', columns, 'table');
		expect(code).toContain('"isJson":true');
	});

	it('should support view meta kind', () => {
		const columns: Record<string, DrizzleColumn> = {
			id: { name: 'id', dataType: 'number', columnType: 'integer', notNull: true },
		};

		const code = generatePlainObject('usersView', columns, 'view');
		expect(code).toContain('__meta: {"kind":"view"}');
	});
});

describe('getSerializedValue', () => {
	it('should serialize simple primitives', () => {
		expect(getSerializedValue(123)).toBe('123');
		expect(getSerializedValue('test')).toBe('"test"');
		expect(getSerializedValue(true)).toBe('true');
		expect(getSerializedValue(null)).toBe('null');
	});

	it('should return undefined for functions and undefined and symbols', () => {
		expect(getSerializedValue(undefined)).toBe('undefined');
		expect(getSerializedValue(() => {})).toBe('undefined');
		expect(getSerializedValue(Symbol('test'))).toBe('undefined');
	});

	it('should serialize arrays and objects', () => {
		expect(getSerializedValue([1, 2, 3])).toBe('[1,2,3]');
		expect(getSerializedValue({ a: 1 })).toBe('{"a":1}');
	});
});

describe('resolveSpecifier', () => {
	const dbDir = path.resolve('/project/db').replace(/\\/g, '/');
	const knownFiles = new Map([
		[`${dbDir}/users`, `${dbDir}/users.ts`],
		[`${dbDir}/tables/index`, `${dbDir}/tables/index.ts`],
	]);

	it('should resolve direct match without extension', () => {
		expect(resolveSpecifier(dbDir, './users', knownFiles)).toBe(`${dbDir}/users`);
	});

	it('should return null if direct resolution already has extension and fails', () => {
		expect(resolveSpecifier(dbDir, './users.css', knownFiles)).toBe(null);
	});

	it('should resolve folder index', () => {
		expect(resolveSpecifier(dbDir, './tables', knownFiles)).toBe(`${dbDir}/tables/index`);
	});

	it('should return null if file not found', () => {
		expect(resolveSpecifier(dbDir, './missing', knownFiles)).toBe(null);
	});
});

describe('hasCallToAny', () => {
	it('should detect direct calls and member calls', () => {
		const mockAst = {
			type: 'Program',
			body: [
				{
					type: 'VariableDeclaration',
					declarations: [
						{
							type: 'VariableDeclarator',
							init: {
								type: 'CallExpression',
								callee: { type: 'Identifier', name: 'pgTable' },
								arguments: [],
							},
						},
					],
				},
			],
		};

		expect(hasCallToAny(mockAst, new Set(['pgTable']))).toBe(true);
		expect(hasCallToAny(mockAst, new Set(['mysqlTable']))).toBe(false);
	});

	it('should detect namespace/dotted calls', () => {
		const mockAst = {
			type: 'CallExpression',
			callee: {
				type: 'StaticMemberExpression',
				object: { type: 'Identifier', name: 'schema' },
				property: { type: 'Identifier', name: 'pgTable' },
			},
		};

		expect(hasCallToAny(mockAst, new Set(['schema']))).toBe(true);
	});
});
