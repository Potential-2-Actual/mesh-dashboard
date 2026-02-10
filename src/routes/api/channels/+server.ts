import { json, error } from '@sveltejs/kit';
import { getKnownChannels } from '$lib/server/nats.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	const channels = await getKnownChannels();
	return json({ channels });
};
