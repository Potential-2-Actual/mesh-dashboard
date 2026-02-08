import { connect, type NatsConnection } from 'nats.ws';
import { env } from '$env/dynamic/private';
import type { MessageEnvelope } from '../types.js';

let nc: NatsConnection | null = null;

async function getConnection(): Promise<NatsConnection> {
	if (nc && !nc.isClosed()) return nc;

	const { fromSeed } = await import('nkeys.js');
	const seed = env.NATS_SEED || '';
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
	const jsm = await conn.jetstreamManager();
	const js = conn.jetstream();

	const messages: MessageEnvelope[] = [];

	try {
		const consumer = await js.consumers.get('MESH-MESSAGES', undefined);
		// Try ordered consumer for last N messages
		const iter = await js.consumers.get('MESH-MESSAGES');
		// Use fetch
		const batch = await iter.fetch({ max_messages: count });
		for await (const msg of batch) {
			try {
				const envelope: MessageEnvelope = JSON.parse(new TextDecoder().decode(msg.data));
				messages.push(envelope);
				msg.ack();
			} catch { /* skip malformed */ }
		}
	} catch (err) {
		console.error('Failed to fetch history:', err);
		// Try a simpler approach - ordered consumer
		try {
			const ordered = await js.consumers.get('MESH-MESSAGES');
			const batch = await ordered.consume({ max_messages: count });
			let i = 0;
			for await (const msg of batch) {
				try {
					const envelope: MessageEnvelope = JSON.parse(new TextDecoder().decode(msg.data));
					messages.push(envelope);
				} catch { /* skip */ }
				i++;
				if (i >= count) break;
			}
		} catch (err2) {
			console.error('History fetch fallback also failed:', err2);
		}
	}

	return messages.slice(-count);
}
