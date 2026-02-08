import type { Handle } from '@sveltejs/kit';
import { getSession } from '$lib/server/auth.js';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = getSession(event.cookies);
	return resolve(event);
};
