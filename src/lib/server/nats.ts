import { connect, type NatsConnection } from 'nats.ws';
import { env } from '$env/dynamic/private';
import type { MessageEnvelope } from '../types.js';

let nc: NatsConnection | null = null;

async function getConnection(): Promise<NatsConnection> {
	if (nc && !nc.isClosed()) return nc;

	const { fromSeed } = await import('nkeys.js');
	const seed = env.NATS_SERVER_SEED || env.NATS_SEED || '';
	const seedBytes = new TextEncoder().encode(seed);
	const kp = fromSeed(seedBytes);

	nc = await connect({
		servers: env.NATS_URL || 'wss://mesh.potential2actual.com/nats',
		authenticator: (nonce?: Uint8Array) => {
			if (!nonce) return;
			const sig = kp.sign(nonce);
			return { nkey: kp.getPublicKey(), sig };
		}
	});

	return nc;
}

export async function fetchHistory(count = 50): Promise<MessageEnvelope[]> {
	const conn = await getConnection();
	const js = conn.jetstream();
	const messages: MessageEnvelope[] = [];

	try {
		// Use ordered consumer — ephemeral, replays from start, auto-cleaned
		const consumer = await js.consumers.get('MESH-MESSAGES');
		const batch = await consumer.fetch({ max_messages: count, expires: 5000 });

		for await (const msg of batch) {
			try {
				const envelope: MessageEnvelope = JSON.parse(new TextDecoder().decode(msg.data));
				messages.push(envelope);
			} catch { /* skip malformed */ }
		}
	} catch (err) {
		console.error('Failed to fetch history:', err);
	}

	// Return last N messages
	return messages.slice(-count);
}
