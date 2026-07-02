import { pgTable, text, integer } from 'drizzle-orm/pg-core';

/* @drizzle-airgap omit secretField */
/**
 * JSDoc comment for secretTable
 * This is to verify JSDoc does not break the directive matching.
 */
// Inline comment for secretTable
export const secretTable = pgTable('secrets', {
	id: integer('id').primaryKey(),
	name: text('name').notNull(),
	secretField: text('secret_field').notNull(),
});

/* @drizzle-airgap pick id, publicField */
/* Multiline comment
   for publicTable to verify it doesn't break directive matching */
export const publicTable = pgTable('publics', {
	id: integer('id').primaryKey(),
	publicField: text('public_field').notNull(),
	privateField: text('private_field').notNull(),
});
