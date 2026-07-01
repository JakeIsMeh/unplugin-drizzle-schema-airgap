<script setup lang="ts">
import { createSelectSchema } from 'drizzle-zod';

import { usersTable } from '../schemas/users';

const schema = createSelectSchema(usersTable);
const parsed = schema.safeParse({ id: 1, name: 'Nuxt E2E Test', role: 'admin', isActive: true });
</script>

<template>
	<div>
		<h1>Nuxt E2E Validation</h1>
		<pre id="validation-result">{{ JSON.stringify(parsed) }}</pre>
	</div>
</template>
