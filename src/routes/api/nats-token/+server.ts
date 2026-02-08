import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	return json({
		seed: env.DASHBOARD_NATS_SEED || '',
		url: env.NATS_URL || 'wss://mesh.potential2actual.com/nats'
	});
};
