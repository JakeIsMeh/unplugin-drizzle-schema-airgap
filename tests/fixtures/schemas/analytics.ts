import { sql } from 'drizzle-orm';
import { pgView, integer, text } from 'drizzle-orm/pg-core';

import { usersTable } from './users';

export const usersView = pgView('users_view', {
	id: integer('id'),
	name: text('name'),
}).as(sql`select id, name from ${usersTable}`);
