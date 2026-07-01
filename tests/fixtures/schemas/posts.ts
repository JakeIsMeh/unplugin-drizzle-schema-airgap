import { pgTable, text, integer } from 'drizzle-orm/pg-core';

import { usersTable } from './users';

export const postsTable = pgTable('posts', {
	id: integer('id').primaryKey(),
	title: text('title').notNull(),
	content: text('content').$defaultFn(() => 'Default Content'),
	authorId: integer('author_id').references(() => usersTable.id),
});
