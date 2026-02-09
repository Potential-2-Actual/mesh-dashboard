import { json, error } from '@sveltejs/kit';
import { searchMessages } from '$lib/server/nats.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const query = url.searchParams.get('q');
	if (!query || query.trim().length === 0) {
		return json({ results: [], total: 0, truncated: false });
	}

	const channel = url.searchParams.get('channel') ?? 'mesh.channel.general';

	try {
		const result = await searchMessages({ query: query.trim(), channel });
		return json(result);
	} catch (err) {
		console.error('Search error:', err);
		return json({ results: [], total: 0, truncated: false });
	}
};
