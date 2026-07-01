import { pgTable, text, integer, boolean, pgEnum, json } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['admin', 'user', 'guest']);

export const usersTable = pgTable('users', {
	id: integer('id').primaryKey(),
	name: text('name').notNull(),
	role: userRoleEnum('role').default('user'),
	isActive: boolean('is_active').notNull().default(true),
	metadata: json('metadata').$type<{ lastLogin: string; tags: string[] }>(),
});

export const unreferencedTable = pgTable('unreferenced', {
	id: integer('id').primaryKey(),
});
