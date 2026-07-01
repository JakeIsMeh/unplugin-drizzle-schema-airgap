import { createSelectSchema } from 'drizzle-zod';

import { usersTable } from '../../../schemas/users';

export default defineEventHandler(() => {
	// The server should NOT be intercepted, so it has access to the full usersTable columns
	// and should validate using the REAL drizzle-zod schemas
	const schema = createSelectSchema(usersTable);
	return {
		kind: (usersTable as any).__meta ? 'interceptor-leaked' : 'drizzle-table-original',
		columns: Object.keys(usersTable),
		schemaType: schema.constructor.name,
	};
});
