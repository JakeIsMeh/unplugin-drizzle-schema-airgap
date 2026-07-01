import { createSelectSchema } from 'drizzle-zod';

import { usersTable } from './schemas';

export const userSelectSchema = createSelectSchema(usersTable);
