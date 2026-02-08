import { redirect } from '@sveltejs/kit';
import { Google } from 'arctic';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types.js';
import crypto from 'crypto';

export const GET: RequestHandler = async ({ cookies }) => {
	if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
		throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required');
	}
	const google = new Google(
		env.GOOGLE_OAUTH_CLIENT_ID,
		env.GOOGLE_OAUTH_CLIENT_SECRET,
		`${env.ORIGIN || 'http://localhost:3100'}/auth/callback`
	);

	const state = crypto.randomBytes(16).toString('hex');
	const codeVerifier = crypto.randomBytes(32).toString('hex');

	cookies.set('oauth_state', state, { path: '/', httpOnly: true, secure: true, maxAge: 600, sameSite: 'lax' });
	cookies.set('oauth_verifier', codeVerifier, { path: '/', httpOnly: true, secure: true, maxAge: 600, sameSite: 'lax' });

	const url = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']);

	throw redirect(302, url.toString());
};
