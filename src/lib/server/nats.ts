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

export async function fetchHistory(options: { before?: number; limit?: number; channel?: string } = {}): Promise<{ messages: any[]; hasMore: boolean }> {
	const { before, limit = 50, channel = 'general' } = options;
	const nc = await getNatsConnection();
	const jsm = await nc.jetstreamManager();
	const js = nc.jetstream();

	try {
		const consumerConfig: any = {
			filter_subject: `mesh.channel.${channel}`,
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

// --- KV membership functions ---
import type { MemberInfo } from '$lib/types.js';

async function getMembersKv() {
	const nc = await getNatsConnection();
	const js = nc.jetstream();
	return js.views.kv('MESH-MEMBERS');
}

/**
 * ⚠️  NATS KV ITERATION PATTERN — DO NOT REFACTOR ⚠️
 *
 * This function deliberately collects ALL keys first, THEN fetches values
 * in a separate loop. This looks like it could be simplified into a single
 * loop, but DO NOT combine them.
 *
 * Calling kv.get() inside a kv.keys() async iterator creates concurrent
 * JetStream consumers on the same KV bucket, which causes consumer conflicts.
 * The result: silently missing entries (only the first key is returned).
 *
 * This bug was fixed twice: Sprint 12 (PR #9) and again in commit 1706f3e.
 * If you're reading this and thinking "I can simplify this" — don't.
 */
export async function getChannelMembers(channel: string): Promise<MemberInfo[]> {
	const kv = await getMembersKv();
	const members: MemberInfo[] = [];
	const prefix = channel + '.';
	try {
		// Step 1: Collect keys (consumes the async iterator fully)
		const matchingKeys: string[] = [];
		const keys = await kv.keys();
		for await (const key of keys) {
			if (key.startsWith(prefix)) {
				matchingKeys.push(key);
			}
		}
		// Step 2: Fetch values (safe — iterator is done)
		for (const key of matchingKeys) {
			try {
				const entry = await kv.get(key);
				if (entry && entry.value && entry.value.length > 0) {
					const info = entry.json() as MemberInfo;
					members.push(info);
				}
			} catch { /* skip */ }
		}
	} catch (err: any) {
		// If no keys exist yet, keys() may throw
		if (!err?.message?.includes('no keys')) {
			console.error('getChannelMembers error:', err);
		}
	}
	return members;
}

export async function addChannelMember(channel: string, name: string, type: 'human' | 'ai'): Promise<void> {
	const kv = await getMembersKv();
	const key = `${channel}.${name}`;
	// Check if already exists
	try {
		const existing = await kv.get(key);
		if (existing && existing.value && existing.value.length > 0) return; // already a member
	} catch { /* not found, proceed */ }
	const info: MemberInfo = { name, type, joinedAt: Date.now() };
	await kv.put(key, JSON.stringify(info));
}

export async function removeChannelMember(channel: string, name: string): Promise<void> {
	const kv = await getMembersKv();
	await kv.delete(`${channel}.${name}`);
}

export async function seedMembersFromHistory(channel: string): Promise<void> {
	const nc = await getNatsConnection();
	const jsm = await nc.jetstreamManager();
	const js = nc.jetstream();

	try {
		const consumer = await jsm.consumers.add('MESH-MESSAGES', {
			filter_subject: `mesh.channel.${channel}`,
			deliver_policy: 'all' as any,
			ack_policy: 'none' as any,
			inactive_threshold: 30_000_000_000
		});
		const sub = await js.consumers.get('MESH-MESSAGES', consumer.name);
		const iter = await sub.fetch({ max_messages: 5000, expires: 4000 });

		const seen = new Set<string>();
		for await (const msg of iter) {
			try {
				const envelope = JSON.parse(new TextDecoder().decode(msg.data));
				if (envelope.v === 1 && envelope.from?.agent && !seen.has(envelope.from.agent)) {
					seen.add(envelope.from.agent);
					await addChannelMember(channel, envelope.from.agent, envelope.from.type === 'human' ? 'human' : 'ai');
				}
			} catch { /* skip */ }
		}
		console.log(`Seeded ${seen.size} members for channel ${channel}`);
	} catch (err) {
		console.error('seedMembersFromHistory error:', err);
	}
}
