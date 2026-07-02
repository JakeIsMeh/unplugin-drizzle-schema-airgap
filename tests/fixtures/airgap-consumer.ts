import { createSelectSchema } from 'drizzle-orm/zod';

import { secretTable, publicTable } from './schemas/airgap-test/airgap';

export const secretSchema = createSelectSchema(secretTable);
export const publicSchema = createSelectSchema(publicTable);
