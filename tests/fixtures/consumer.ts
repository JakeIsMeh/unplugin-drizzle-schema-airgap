import { createSelectSchema } from 'drizzle-orm/zod';

import { usersTable } from './schemas';

export const userSelectSchema = createSelectSchema(usersTable);
