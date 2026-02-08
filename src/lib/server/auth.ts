import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import crypto from 'crypto';

const COOKIE_NAME = 'mesh_session';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

interface SessionData {
	email: string;
	name: string;
	exp: number;
}

function getSecret(): string {
	return env.SESSION_SECRET || 'dev-secret-change-me';
}

function sign(payload: string): string {
	const hmac = crypto.createHmac('sha256', getSecret());
	hmac.update(payload);
	return hmac.digest('base64url');
}

function verify(payload: string, signature: string): boolean {
	return sign(payload) === signature;
}

export function setSession(cookies: Cookies, data: { email: string; name: string }) {
	const session: SessionData = {
		email: data.email,
		name: data.name,
		exp: Math.floor(Date.now() / 1000) + MAX_AGE
	};
	const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
	const sig = sign(payload);
	const token = `${payload}.${sig}`;

	cookies.set(COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		maxAge: MAX_AGE
	});
}

export function getSession(cookies: Cookies): { email: string; name: string } | null {
	const token = cookies.get(COOKIE_NAME);
	if (!token) return null;

	const parts = token.split('.');
	if (parts.length !== 2) return null;

	const [payload, sig] = parts;
	if (!verify(payload, sig)) return null;

	try {
		const data: SessionData = JSON.parse(Buffer.from(payload, 'base64url').toString());
		if (data.exp < Math.floor(Date.now() / 1000)) return null;
		return { email: data.email, name: data.name };
	} catch {
		return null;
	}
}

export function clearSession(cookies: Cookies) {
	cookies.delete(COOKIE_NAME, { path: '/' });
}

export function isEmailAllowed(email: string): boolean {
	const allowed = env.ALLOWED_EMAILS || '';
	const list = allowed.split(',').map((e) => e.trim().toLowerCase());
	return list.includes(email.toLowerCase());
}
