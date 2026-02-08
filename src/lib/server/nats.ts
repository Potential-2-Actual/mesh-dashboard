import { connect, type NatsConnection, nkeyAuthenticator } from 'nats';
import { env } from '$env/dynamic/private';
import { readFileSync } from 'fs';

let connection: NatsConnection | null = null;

export async function getNatsConnection(): Promise<NatsConnection> {
	if (connection && !connection.isClosed()) {
		return connection;
	}

	// Server-side uses TCP (nats://), not WebSocket
	const url = env.NATS_URL ?? 'nats://10.162.0.3:4222';
	const seedPath = env.NATS_WRITE_SEED_PATH;

	if (!seedPath) {
		throw new Error('NATS_WRITE_SEED_PATH not configured');
	}

	const seed = readFileSync(seedPath, 'utf-8').split('\n')[0].trim();
	const seedBytes = new TextEncoder().encode(seed);

	connection = await connect({
		servers: [url],
		name: 'mesh-dashboard-server',
		authenticator: nkeyAuthenticator(seedBytes),
		reconnect: true,
		maxReconnectAttempts: -1,
		reconnectTimeWait: 2000
	});

	return connection;
}

export async function fetchHistory(maxMessages: number = 50): Promise<any[]> {
	const nc = await getNatsConnection();
	const jsm = await nc.jetstreamManager();
	const js = nc.jetstream();

	try {
		// Create ephemeral ordered consumer for replay
		const consumer = await jsm.consumers.add('MESH-MESSAGES', {
			deliver_policy: 'last_per_subject' as any,
			filter_subject: 'mesh.channel.general',
			ack_policy: 'none' as any,
			inactive_threshold: 30_000_000_000 // 30s nanos — auto-cleanup
		});

		const sub = await js.consumers.get('MESH-MESSAGES', consumer.name);
		const iter = await sub.fetch({ max_messages: maxMessages, expires: 3000 });

		const messages: any[] = [];
		for await (const msg of iter) {
			try {
				const envelope = JSON.parse(new TextDecoder().decode(msg.data));
				if (envelope.v === 1) {
					messages.push(envelope);
				}
			} catch { /* skip malformed */ }
		}

		messages.sort((a, b) => a.ts - b.ts);
		return messages;
	} catch (err) {
		console.error('JetStream history fetch failed:', err);
		return [];
	}
}
