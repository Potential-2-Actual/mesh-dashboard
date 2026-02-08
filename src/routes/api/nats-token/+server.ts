import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { env } from '$env/dynamic/private';

const SEED_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const seed = env.DASHBOARD_BROWSER_SEED || '';
	if (!seed) throw error(500, 'NATS browser seed not configured');

	const expiresAt = Date.now() + SEED_TTL_MS;

	return json(
		{ seed, url: env.NATS_URL || 'wss://mesh.potential2actual.com/nats', expiresAt, ttlMs: SEED_TTL_MS },
		{
			headers: {
				'Cache-Control': 'no-store, no-cache, must-revalidate',
				Pragma: 'no-cache'
			}
		}
	);
};
