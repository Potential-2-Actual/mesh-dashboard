import { redirect } from '@sveltejs/kit';
import { clearSession } from '$lib/server/auth.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ cookies }) => {
	clearSession(cookies);
	throw redirect(302, '/auth/login');
};
