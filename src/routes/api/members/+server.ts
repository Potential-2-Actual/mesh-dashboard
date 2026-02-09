import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getChannelMembers, addChannelMember, removeChannelMember, seedMembersFromHistory } from '$lib/server/nats.js';

let seeded = new Set<string>();

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	const channel = url.searchParams.get('channel') ?? 'general';

	// Auto-seed on first request if empty
	if (!seeded.has(channel)) {
		seeded.add(channel);
		const existing = await getChannelMembers(channel);
		if (existing.length === 0) {
			await seedMembersFromHistory(channel);
		}
	}

	const members = await getChannelMembers(channel);
	return json({ members });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	const body = await request.json();
	const { channel, name, type, action } = body;

	if (!channel || !name || !action) throw error(400, 'Missing fields');

	if (action === 'add') {
		await addChannelMember(channel, name, type ?? 'human');
	} else if (action === 'remove') {
		await removeChannelMember(channel, name);
	} else {
		throw error(400, 'Invalid action');
	}

	return json({ ok: true });
};
