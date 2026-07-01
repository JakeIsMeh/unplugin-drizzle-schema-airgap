import * as path from 'node:path';

export interface DrizzleColumn {
	name: string;
	dataType: string;
	columnType: string;
	notNull: boolean;
	hasDefault?: boolean;
	config?: {
		length?: number;
	};
	enumValues?: string[];
}

/**
 * Generates a library-agnostic metadata object representation of columns.
 */
export function generatePlainObject(
	name: string,
	columns: Record<string, DrizzleColumn>,
	kind: 'table' | 'view',
): string {
	const fields: string[] = [];
	fields.push(`  __meta: ${JSON.stringify({ kind })},`);
	const entries = Object.entries(columns || {});

	for (const [colKey, column] of entries) {
		const meta: Record<string, string | number | boolean | string[] | undefined> = {
			dataType: column.dataType,
			notNull: column.notNull,
		};
		const colType = column.columnType?.toLowerCase() || '';
		if (colType.includes('uuid')) {
			meta.isUuid = true;
		}
		if (column.hasDefault) {
			meta.hasDefault = true;
		}
		if (column.config?.length) {
			meta.length = column.config.length;
		}
		if (column.enumValues && column.enumValues.length > 0) {
			meta.enumValues = column.enumValues;
		}

		// Flag JSON columns for structural validation
		const isBlobJson =
			column.dataType === 'blob' && column.columnType?.toLowerCase().includes('json');
		if (column.dataType.includes('json') || isBlobJson) {
			meta.isJson = true;
		}

		fields.push(`  ${colKey}: ${JSON.stringify(meta)},`);
	}

	const innerCode = fields.length > 0 ? `\n${fields.join('\n')}\n` : '';
	return `export const ${name} = {${innerCode}};`;
}

/**
 * Safely serializes simple constants, falling back to 'undefined'.
 */
export function getSerializedValue(val: unknown): string {
	if (val === undefined) return 'undefined';
	if (typeof val === 'function') return 'undefined';
	if (typeof val === 'symbol') return 'undefined';

	try {
		const json = JSON.stringify(val);
		if (json === undefined) return 'undefined';
		return json;
	} catch {
		return 'undefined';
	}
}

/**
 * Checks if any identifier in the set is invoked as a CallExpression callee.
 */
export function hasCallToAny(node: unknown, names: Set<string>): boolean {
	if (!node || typeof node !== 'object') return false;
	const n = node as Record<string, unknown>;

	if (n.type === 'CallExpression') {
		const callee = n.callee as Record<string, unknown> | undefined;
		if (callee?.type === 'Identifier' && names.has(callee.name as string)) {
			return true;
		}
		// Support both OXC's StaticMemberExpression and standard MemberExpression
		if (callee?.type === 'StaticMemberExpression' || callee?.type === 'MemberExpression') {
			const obj = callee.object as Record<string, unknown> | undefined;
			if (obj?.type === 'Identifier' && names.has(obj.name as string)) {
				return true;
			}
		}
	}

	for (const value of Object.values(n)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (hasCallToAny(item, names)) return true;
			}
		} else if (value && typeof value === 'object') {
			if (hasCallToAny(value, names)) return true;
		}
	}
	return false;
}

/**
 * Resolves a relative module specifier against known file paths.
 */
export function resolveSpecifier(
	fromDir: string,
	specifier: string,
	knownFiles: Map<string, string>,
): string | null {
	const resolved = path.resolve(fromDir, specifier).replace(/\\/g, '/');
	const noExt = resolved.replace(/\.[^/.]+$/, '');

	if (knownFiles.has(noExt)) {
		if (resolved !== noExt) {
			const ext = path.extname(resolved).toLowerCase();
			const validExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
			if (!validExtensions.includes(ext)) {
				return null;
			}
		}
		return noExt;
	}

	if (resolved !== noExt) return null;

	const asIndex = resolved + '/index';
	if (knownFiles.has(asIndex)) return asIndex;

	return null;
}

/**
 * Returns the shim module code with runtime compiler logic.
 *
 * Each shim differentiates between select, insert, and update schemas:
 * - **select**: nullable columns are optional, everything else required
 * - **insert**: columns with `hasDefault` or nullable are optional; throws for views
 * - **update**: all columns optional (partial update semantics); throws for views
 */
export function getValidatorShimCode(library: string, resolvedPath: string): string | null {
	switch (library) {
		case 'zod':
			return `
import { z } from '${resolvedPath}';

function buildZodSchema(table, mode) {
  const shape = {};
  for (const [key, col] of Object.entries(table)) {
    if (key === '__meta') continue;
    let validator;
    if (col.enumValues && col.enumValues.length > 0) {
      validator = z.enum(col.enumValues);
    } else if (col.dataType.startsWith('number')) {
      validator = z.number();
    } else if (col.dataType.startsWith('bigint')) {
      validator = z.bigint();
    } else if (col.dataType.startsWith('string')) {
      const isUUID = col.isUuid;
      validator = isUUID ? z.string().uuid() : z.string();
      if (col.length) validator = validator.max(col.length);
    } else if (col.dataType.startsWith('boolean')) {
      validator = z.boolean();
    } else if (col.dataType.startsWith('date')) {
      validator = z.date();
    } else if (col.isJson) {
      validator = z.record(z.string(), z.unknown());
    } else {
      validator = z.any();
    }

    let isOptional;
    if (mode === 'update') {
      isOptional = true;
    } else if (mode === 'insert') {
      isOptional = !col.notNull || col.hasDefault;
    } else {
      isOptional = !col.notNull;
    }

    if (isOptional) {
      validator = validator.optional();
    }
    shape[key] = validator;
  }
  return shape;
}

export function createSelectSchema(table, overrides) {
  return z.object({ ...buildZodSchema(table, 'select'), ...overrides });
}
export function createInsertSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create insert schema for a view');
  return z.object({ ...buildZodSchema(table, 'insert'), ...overrides });
}
export function createUpdateSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create update schema for a view');
  return z.object({ ...buildZodSchema(table, 'update'), ...overrides });
}
`;
		case 'valibot':
			return `
import * as v from '${resolvedPath}';

function buildValibotSchema(table, mode) {
  const shape = {};
  for (const [key, col] of Object.entries(table)) {
    if (key === '__meta') continue;
    let validator;
    if (col.enumValues && col.enumValues.length > 0) {
      validator = v.picklist(col.enumValues);
    } else if (col.dataType.startsWith('number')) {
      validator = v.number();
    } else if (col.dataType.startsWith('bigint')) {
      validator = v.bigint();
    } else if (col.dataType.startsWith('string')) {
      const isUUID = col.isUuid;
      validator = isUUID ? v.pipe(v.string(), v.uuid()) : v.string();
      if (col.length) validator = v.pipe(validator, v.maxLength(col.length));
    } else if (col.dataType.startsWith('boolean')) {
      validator = v.boolean();
    } else if (col.dataType.startsWith('date')) {
      validator = v.date();
    } else if (col.isJson) {
      validator = v.record(v.string(), v.unknown());
    } else {
      validator = v.any();
    }

    let isOptional;
    if (mode === 'update') {
      isOptional = true;
    } else if (mode === 'insert') {
      isOptional = !col.notNull || col.hasDefault;
    } else {
      isOptional = !col.notNull;
    }

    if (isOptional) {
      validator = v.optional(validator);
    }
    shape[key] = validator;
  }
  return shape;
}

export function createSelectSchema(table, overrides) {
  return v.object({ ...buildValibotSchema(table, 'select'), ...overrides });
}
export function createInsertSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create insert schema for a view');
  return v.object({ ...buildValibotSchema(table, 'insert'), ...overrides });
}
export function createUpdateSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create update schema for a view');
  return v.object({ ...buildValibotSchema(table, 'update'), ...overrides });
}
`;
		case 'typebox':
			return `
import { Type } from '${resolvedPath}';

function buildTypeBoxSchema(table, mode) {
  const shape = {};
  for (const [key, col] of Object.entries(table)) {
    if (key === '__meta') continue;
    let validator;
    if (col.enumValues && col.enumValues.length > 0) {
      validator = Type.Union(col.enumValues.map(val => Type.Literal(val)));
    } else if (col.dataType.startsWith('number')) {
      validator = Type.Number();
    } else if (col.dataType.startsWith('bigint')) {
      validator = Type.BigInt();
    } else if (col.dataType.startsWith('string')) {
      const isUUID = col.isUuid;
      validator = isUUID ? Type.String({ format: 'uuid' }) : Type.String();
      if (col.length) validator = Type.String({ maxLength: col.length });
    } else if (col.dataType.startsWith('boolean')) {
      validator = Type.Boolean();
    } else if (col.dataType.startsWith('date')) {
      validator = Type.Date();
    } else if (col.isJson) {
      validator = Type.Record(Type.String(), Type.Unknown());
    } else {
      validator = Type.Any();
    }

    let isOptional;
    if (mode === 'update') {
      isOptional = true;
    } else if (mode === 'insert') {
      isOptional = !col.notNull || col.hasDefault;
    } else {
      isOptional = !col.notNull;
    }

    if (isOptional) {
      validator = Type.Optional(validator);
    }
    shape[key] = validator;
  }
  return shape;
}

export function createSelectSchema(table, overrides) {
  return Type.Object({ ...buildTypeBoxSchema(table, 'select'), ...overrides });
}
export function createInsertSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create insert schema for a view');
  return Type.Object({ ...buildTypeBoxSchema(table, 'insert'), ...overrides });
}
export function createUpdateSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create update schema for a view');
  return Type.Object({ ...buildTypeBoxSchema(table, 'update'), ...overrides });
}
`;
		case 'effect':
			return `
import * as S from '${resolvedPath}';

function buildEffectSchema(table, mode) {
  const shape = {};
  for (const [key, col] of Object.entries(table)) {
    if (key === '__meta') continue;
    let validator;
    if (col.enumValues && col.enumValues.length > 0) {
      validator = S.Union(...col.enumValues.map(val => S.Literal(val)));
    } else if (col.dataType.startsWith('number')) {
      validator = S.Number;
    } else if (col.dataType.startsWith('bigint')) {
      validator = S.BigIntFromSelf;
    } else if (col.dataType.startsWith('string')) {
      const isUUID = col.isUuid;
      validator = isUUID ? S.UUID : S.String;
      if (col.length) validator = S.String.pipe(S.maxLength(col.length));
    } else if (col.dataType.startsWith('boolean')) {
      validator = S.Boolean;
    } else if (col.dataType.startsWith('date')) {
      validator = S.Date;
    } else if (col.isJson) {
      validator = S.Record({ key: S.String, value: S.Unknown });
    } else {
      validator = S.Any;
    }

    let isOptional;
    if (mode === 'update') {
      isOptional = true;
    } else if (mode === 'insert') {
      isOptional = !col.notNull || col.hasDefault;
    } else {
      isOptional = !col.notNull;
    }

    if (isOptional) {
      validator = S.optional(validator);
    }
    shape[key] = validator;
  }
  return shape;
}

export function createSelectSchema(table, overrides) {
  return S.Struct({ ...buildEffectSchema(table, 'select'), ...overrides });
}
export function createInsertSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create insert schema for a view');
  return S.Struct({ ...buildEffectSchema(table, 'insert'), ...overrides });
}
export function createUpdateSchema(table, overrides) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create update schema for a view');
  return S.Struct({ ...buildEffectSchema(table, 'update'), ...overrides });
}
`;
		case 'arktype':
			return `
import { type } from '${resolvedPath}';

function buildArkTypeShape(table, mode) {
  const shape = {};
  for (const [key, col] of Object.entries(table)) {
    if (key === '__meta') continue;
    let typeStr = 'unknown';
    if (col.enumValues && col.enumValues.length > 0) {
      typeStr = col.enumValues.map(val => "'" + val + "'").join('|');
    } else if (col.dataType.startsWith('number')) {
      typeStr = 'number';
    } else if (col.dataType.startsWith('bigint')) {
      typeStr = 'bigint';
    } else if (col.dataType.startsWith('string')) {
      typeStr = 'string';
    } else if (col.dataType.startsWith('boolean')) {
      typeStr = 'boolean';
    } else if (col.dataType.startsWith('date')) {
      typeStr = 'Date';
    } else if (col.isJson) {
      typeStr = 'object';
    }

    let isOptional;
    if (mode === 'update') {
      isOptional = true;
    } else if (mode === 'insert') {
      isOptional = !col.notNull || col.hasDefault;
    } else {
      isOptional = !col.notNull;
    }

    const finalKey = isOptional ? (key + '?') : key;
    shape[finalKey] = typeStr;
  }
  return shape;
}

function mergeArkType(table, mode, overrides) {
  const base = buildArkTypeShape(table, mode);
  const merged = { ...base };
  for (const key of Object.keys(overrides)) {
    delete merged[key];
    delete merged[key + '?'];
    merged[key] = overrides[key];
  }
  return type(merged);
}

export function createSelectSchema(table, overrides = {}) {
  return mergeArkType(table, 'select', overrides);
}
export function createInsertSchema(table, overrides = {}) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create insert schema for a view');
  return mergeArkType(table, 'insert', overrides);
}
export function createUpdateSchema(table, overrides = {}) {
  if (table.__meta?.kind === 'view') throw new Error('[drizzle-schema-airgap] Cannot create update schema for a view');
  return mergeArkType(table, 'update', overrides);
}
`;
		default:
			return null;
	}
}
