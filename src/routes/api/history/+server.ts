import { json, error } from '@sveltejs/kit';
import { fetchHistory } from '$lib/server/nats.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const beforeParam = url.searchParams.get('before');
	const limitParam = url.searchParams.get('limit');

	const before = beforeParam ? parseFloat(beforeParam) : undefined;
	const limit = limitParam ? parseInt(limitParam, 10) : 50;

	try {
		const result = await fetchHistory({ before, limit });
		return json(result);
	} catch (err) {
		console.error('History fetch error:', err);
		return json({ messages: [], hasMore: false });
	}
};
