import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getServerConnection } from '$lib/server/nats.js';
import { addChannelMember } from '$lib/server/nats.js';
import type { MessageEnvelope } from '$lib/types.js';

const MAX_MESSAGE_SIZE = 64 * 1024;
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const email = locals.user.email;
	const now = Date.now();
	let rl = rateLimitMap.get(email);
	if (!rl || now > rl.resetAt) {
		rl = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
		rateLimitMap.set(email, rl);
	}
	rl.count++;
	if (rl.count > RATE_LIMIT_MAX) {
		throw error(429, 'Rate limit exceeded');
	}

	const body = await request.json();
	const { text, subject } = body;

	if (!text || typeof text !== 'string') throw error(400, 'Missing text');
	if (text.length > MAX_MESSAGE_SIZE) throw error(400, 'Message too large');
	if (!subject || !subject.startsWith('mesh.channel.')) throw error(400, 'Invalid subject');
	if (subject.startsWith('mesh.dm.')) throw error(403, 'DM not allowed');

	const senderName = (locals.user.name || 'gp').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'gp';

	const envelope: MessageEnvelope = {
		v: 1,
		id: crypto.randomUUID(),
		from: { agent: senderName, type: 'human' },
		to: { subject },
		content: { text },
		ts: Math.floor(Date.now() / 1000),
		replyTo: null
	};

	const nc = await getServerConnection();
	nc.publish(subject, new TextEncoder().encode(JSON.stringify(envelope)));

	// Auto-register sender as member
	const channel = subject.replace('mesh.channel.', '');
	addChannelMember(channel, senderName, 'human').catch(() => {});

	return json({ ok: true, id: envelope.id });
};
