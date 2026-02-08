import { redirect, error } from '@sveltejs/kit';
import { Google } from 'arctic';
import { env } from '$env/dynamic/private';
import { setSession, isEmailAllowed } from '$lib/server/auth.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('oauth_state');
	const codeVerifier = cookies.get('oauth_verifier');

	if (!code || !state || state !== storedState || !codeVerifier) {
		throw error(400, 'Invalid OAuth callback');
	}

	cookies.delete('oauth_state', { path: '/' });
	cookies.delete('oauth_verifier', { path: '/' });

	const google = new Google(
		env.GOOGLE_CLIENT_ID || '',
		env.GOOGLE_CLIENT_SECRET || '',
		`${env.ORIGIN || 'http://localhost:3100'}/auth/callback`
	);

	const tokens = await google.validateAuthorizationCode(code, codeVerifier);
	const accessToken = tokens.accessToken();

	// Fetch user info
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	const userInfo = await res.json();

	if (!userInfo.email || !isEmailAllowed(userInfo.email)) {
		throw error(403, 'Access denied');
	}

	setSession(cookies, { email: userInfo.email, name: userInfo.name || userInfo.email });

	throw redirect(302, '/');
};
