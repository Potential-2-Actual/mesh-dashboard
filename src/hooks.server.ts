import type { Handle } from '@sveltejs/kit';
import { getSession } from '$lib/server/auth.js';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = getSession(event.cookies);

	const response = await resolve(event);

	// CSP headers
	response.headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'", // Tailwind needs inline styles
			`connect-src 'self' wss://${event.url.host}`,
			"img-src 'self' data: https://lh3.googleusercontent.com", // Google avatars
			"font-src 'self'",
			"frame-src 'none'",
			"object-src 'none'",
			"base-uri 'self'"
		].join('; ')
	);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

	return response;
};
