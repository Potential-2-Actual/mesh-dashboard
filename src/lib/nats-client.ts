import { connect, type NatsConnection, type Subscription, nkeyAuthenticator } from 'nats.ws';
import { messages, presence, connectionStatus, systemEvents } from './stores.js';
import type { MessageEnvelope, PresenceInfo } from './types.js';
import { get } from 'svelte/store';

let nc: NatsConnection | null = null;
let subs: Subscription[] = [];
let seedExpiresAt = 0;
let currentNatsUrl = '';
let presenceInterval: ReturnType<typeof setInterval> | null = null;

async function fetchSeed(): Promise<string> {
	const res = await fetch('/api/nats-token');
	if (!res.ok) throw new Error('Failed to fetch NATS credentials');
	const { seed, expiresAt } = await res.json();
	seedExpiresAt = expiresAt;
	return seed;
}

export async function connectNats(natsUrl: string, seed: string, userName?: string) {
	currentNatsUrl = natsUrl;
	connectionStatus.set('connecting');

	try {
		const seedBytes = new TextEncoder().encode(seed);

		nc = await connect({
			servers: natsUrl,
			authenticator: nkeyAuthenticator(seedBytes),
			reconnect: true,
			maxReconnectAttempts: -1,
			reconnectTimeWait: 2000
		});

		connectionStatus.set('connected');

		// Monitor connection status + re-fetch seed on reconnect
		(async () => {
			for await (const s of nc!.status()) {
				if (s.type === 'disconnect' || s.type === 'error') {
					connectionStatus.set('disconnected');
				} else if (s.type === 'reconnect') {
					connectionStatus.set('connected');
					// Re-fetch seed if TTL expired
					if (Date.now() > seedExpiresAt) {
						try {
							await fetchSeed();
						} catch (err) {
							console.warn('Seed re-fetch failed:', err);
						}
					}
				}
			}
		})();

		// Subscribe to channels
		const channelSub = nc.subscribe('mesh.channel.general');
		subs.push(channelSub);
		(async () => {
			for await (const msg of channelSub) {
				try {
					const envelope: MessageEnvelope = JSON.parse(new TextDecoder().decode(msg.data));
					messages.update((msgs) => [...msgs, envelope]);
				} catch { /* ignore malformed */ }
			}
		})();

		const systemSub = nc.subscribe('mesh.system.>');
		subs.push(systemSub);
		(async () => {
			for await (const msg of systemSub) {
				try {
					const envelope: MessageEnvelope = JSON.parse(new TextDecoder().decode(msg.data));
					systemEvents.update((evts) => [...evts, envelope]);
					messages.update((msgs) => [...msgs, envelope]);
				} catch { /* ignore */ }
			}
		})();

		const presenceSub = nc.subscribe('mesh.presence.>');
		subs.push(presenceSub);
		(async () => {
			for await (const msg of presenceSub) {
				try {
					const data = JSON.parse(new TextDecoder().decode(msg.data));
					const agent = msg.subject.split('.').pop() || 'unknown';
					const info: PresenceInfo = {
						agent,
						type: data.type || 'unknown',
						status: data.status || 'online',
						lastSeen: Date.now()
					};
					presence.update((p) => {
						const next = new Map(p);
						if (info.status === 'offline') {
							next.delete(agent);
						} else {
							next.set(agent, info);
						}
						return next;
					});
				} catch { /* ignore */ }
			}
		})();

		// Publish presence heartbeat for dashboard user
		if (userName) {
			const publishPresence = () => {
				if (nc && !nc.isClosed()) {
					nc.publish(`mesh.presence.${userName}`, new TextEncoder().encode(JSON.stringify({
						type: 'human',
						status: 'online',
						ts: Date.now()
					})));
				}
			};
			publishPresence(); // immediately
			presenceInterval = setInterval(publishPresence, 30000); // every 30s
		}

	} catch (err) {
		console.error('NATS connection failed:', err);
		connectionStatus.set('disconnected');
		throw err;
	}
}

export async function publishMessage(text: string): Promise<void> {
	// Publish via server-side API (hybrid model: browser subscribes, server publishes)
	const res = await fetch('/api/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text, subject: 'mesh.channel.general' })
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Send failed: ${err}`);
	}
}

export async function disconnectNats() {
	if (presenceInterval) {
		clearInterval(presenceInterval);
		presenceInterval = null;
	}
	for (const s of subs) s.unsubscribe();
	subs = [];
	if (nc) {
		await nc.drain();
		nc = null;
	}
	connectionStatus.set('disconnected');
}
