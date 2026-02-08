import { json, error } from '@sveltejs/kit';
import { fetchHistory } from '$lib/server/nats.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	try {
		const messages = await fetchHistory(50);
		return json(messages);
	} catch (err) {
		console.error('History fetch error:', err);
		return json([]);
	}
};
