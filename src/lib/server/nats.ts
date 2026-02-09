import { connect, type NatsConnection, nkeyAuthenticator } from 'nats';
import { env } from '$env/dynamic/private';
import { readFileSync } from 'fs';

let connection: NatsConnection | null = null;

export const getServerConnection = getNatsConnection;

export async function getNatsConnection(): Promise<NatsConnection> {
	if (connection && !connection.isClosed()) {
		return connection;
	}

	// Server-side uses TCP (nats://), not WebSocket
	const url = env.NATS_SERVER_URL ?? 'nats://10.162.0.3:4222';
	let seed: string;
	const seedPath = env.NATS_WRITE_SEED_PATH;
	if (seedPath) {
		seed = readFileSync(seedPath, 'utf-8').split('\n')[0].trim();
	} else if (env.NATS_SERVER_SEED) {
		seed = env.NATS_SERVER_SEED;
	} else {
		throw new Error('NATS_WRITE_SEED_PATH or NATS_SERVER_SEED must be configured');
	}
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

export async function fetchHistory(options: { before?: number; limit?: number } = {}): Promise<{ messages: any[]; hasMore: boolean }> {
	const { before, limit = 50 } = options;
	const nc = await getNatsConnection();
	const jsm = await nc.jetstreamManager();
	const js = nc.jetstream();

	try {
		const consumerConfig: any = {
			filter_subject: 'mesh.channel.general',
			ack_policy: 'none' as any,
			inactive_threshold: 30_000_000_000
		};

		if (before) {
			// Fetch all messages up to `before` timestamp, then take the last `limit`
			consumerConfig.deliver_policy = 'all';
		} else {
			// Initial load: get all messages, take the last `limit`
			consumerConfig.deliver_policy = 'all';
		}

		const consumer = await jsm.consumers.add('MESH-MESSAGES', consumerConfig);
		const sub = await js.consumers.get('MESH-MESSAGES', consumer.name);
		// Fetch more than needed to determine hasMore
		const iter = await sub.fetch({ max_messages: 5000, expires: 4000 });

		const allMessages: any[] = [];
		for await (const msg of iter) {
			try {
				const envelope = JSON.parse(new TextDecoder().decode(msg.data));
				if (envelope.v === 1) {
					allMessages.push(envelope);
				}
			} catch { /* skip malformed */ }
		}

		// Sort chronologically
		allMessages.sort((a, b) => a.ts - b.ts);

		// Filter by `before` if specified
		let filtered = before
			? allMessages.filter((m) => m.ts < before)
			: allMessages;

		// Take the last `limit` messages (most recent ones before the cutoff)
		const hasMore = filtered.length > limit;
		const messages = filtered.slice(-limit);

		return { messages, hasMore };
	} catch (err) {
		console.error('JetStream history fetch failed:', err);
		return { messages: [], hasMore: false };
	}
}

export async function searchMessages(options: { query: string; channel?: string }): Promise<{ results: any[]; total: number; truncated: boolean }> {
	const { query, channel = 'mesh.channel.general' } = options;
	const nc = await getNatsConnection();
	const jsm = await nc.jetstreamManager();
	const js = nc.jetstream();

	const MAX_RESULTS = 100;
	const TIMEOUT_MS = 5000;

	try {
		const consumer = await jsm.consumers.add('MESH-MESSAGES', {
			deliver_policy: 'all' as any,
			filter_subject: channel,
			ack_policy: 'none' as any,
			inactive_threshold: 30_000_000_000
		});

		const sub = await js.consumers.get('MESH-MESSAGES', consumer.name);
		const iter = await sub.fetch({ max_messages: 5000, expires: 4000 });

		const results: any[] = [];
		const lowerQuery = query.toLowerCase();
		const startTime = Date.now();
		let total = 0;
		let truncated = false;

		for await (const msg of iter) {
			if (Date.now() - startTime > TIMEOUT_MS) {
				truncated = true;
				break;
			}
			try {
				const envelope = JSON.parse(new TextDecoder().decode(msg.data));
				if (envelope.v === 1 && envelope.content?.text?.toLowerCase().includes(lowerQuery)) {
					total++;
					if (results.length < MAX_RESULTS) {
						results.push(envelope);
					} else {
						truncated = true;
					}
				}
			} catch { /* skip */ }
		}

		results.sort((a, b) => a.ts - b.ts);
		return { results, total, truncated };
	} catch (err) {
		console.error('JetStream search failed:', err);
		return { results: [], total: 0, truncated: false };
	}
}
