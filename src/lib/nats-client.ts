import { connect, type NatsConnection, type Subscription, nkeyAuthenticator } from 'nats.ws';
import { messages, presence, connectionStatus, systemEvents, telemetry, receipts } from './stores.js';
import type { MessageEnvelope, PresenceInfo, TelemetryPayload, SessionHistoryResponse } from './types.js';
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

		// Load presence from KV bucket (instant member list)
		(async () => {
			try {
				const js = nc!.jetstream();
				const kv = await js.views.kv('MESH-PRESENCE');

				// Read all entries - collect keys first, then fetch (avoid consumer conflicts)
				const keys: string[] = [];
				for await (const key of await kv.keys()) {
					keys.push(key);
				}
				for (const key of keys) {
					const entry = await kv.get(key);
					if (entry?.value) {
						const data = JSON.parse(new TextDecoder().decode(entry.value));
						const info: PresenceInfo = {
							agent: data.name || key,
							type: data.type || 'unknown',
							status: data.status || 'online',
							lastSeen: data.lastSeen ? new Date(data.lastSeen).getTime() : Date.now()
						};
						presence.update((p) => {
							const next = new Map(p);
							next.set(info.agent, info);
							return next;
						});
					}
				}

				// Watch for live KV updates
				const watch = await kv.watch();
				for await (const entry of watch) {
					if (entry.operation === 'DEL' || entry.operation === 'PURGE') {
						presence.update((p) => {
							const next = new Map(p);
							next.delete(entry.key);
							return next;
						});
					} else if (entry.value) {
						const data = JSON.parse(new TextDecoder().decode(entry.value));
						const info: PresenceInfo = {
							agent: data.name || entry.key,
							type: data.type || 'unknown',
							status: data.status || 'online',
							lastSeen: data.lastSeen ? new Date(data.lastSeen).getTime() : Date.now()
						};
						presence.update((p) => {
							const next = new Map(p);
							if (info.status === 'offline') {
								next.delete(info.agent);
							} else {
								next.set(info.agent, info);
							}
							return next;
						});
					}
				}
			} catch (err) {
				console.warn('KV presence load failed (falling back to pub/sub):', err);
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

		// Load telemetry from localStorage cache for instant render
		try {
			const cached = localStorage.getItem('mesh-telemetry-cache');
			if (cached) {
				const entries: Record<string, TelemetryPayload> = JSON.parse(cached);
				telemetry.update((t) => {
					const next = new Map(t);
					for (const [k, v] of Object.entries(entries)) {
						next.set(k, v);
					}
					return next;
				});
			}
		} catch { /* ignore */ }

		// Load telemetry from KV bucket (instant dashboard loading)
		(async () => {
			try {
				const js = nc!.jetstream();
				const kv = await js.views.kv('MESH-TELEMETRY');

				// Read all entries - collect keys first, then fetch
				const keys: string[] = [];
				for await (const key of await kv.keys()) {
					keys.push(key);
				}
				for (const key of keys) {
					const entry = await kv.get(key);
					if (entry?.value) {
						const raw = JSON.parse(new TextDecoder().decode(entry.value));
						// KV contains lean summary — convert to TelemetryPayload shape for nav
						const data: TelemetryPayload = raw.sessions ? raw : {
							agent: raw.agent,
							version: raw.version,
							model: raw.model,
							sessions: { total: raw.sessionCount ?? 0, active: raw.activeCount ?? 0, list: [] },
							subAgents: { running: 0, completed: 0 },
							ts: raw.ts,
						};
						telemetry.update((t) => {
							const next = new Map(t);
							next.set(data.agent, data);
							return next;
						});
					}
				}

				// Cache to localStorage
				telemetry.subscribe((t) => {
					try {
						const obj: Record<string, TelemetryPayload> = {};
						t.forEach((v, k) => { obj[k] = v; });
						localStorage.setItem('mesh-telemetry-cache', JSON.stringify(obj));
					} catch { /* ignore */ }
				});

				// Watch for live KV updates
				const watch = await kv.watch();
				for await (const entry of watch) {
					if (entry.operation === 'DEL' || entry.operation === 'PURGE') {
						telemetry.update((t) => {
							const next = new Map(t);
							next.delete(entry.key);
							return next;
						});
					} else if (entry.value) {
						const raw = JSON.parse(new TextDecoder().decode(entry.value));
						const data: TelemetryPayload = raw.sessions ? raw : {
							agent: raw.agent,
							version: raw.version,
							model: raw.model,
							sessions: { total: raw.sessionCount ?? 0, active: raw.activeCount ?? 0, list: [] },
							subAgents: { running: 0, completed: 0 },
							ts: raw.ts,
						};
						telemetry.update((t) => {
							const next = new Map(t);
							next.set(data.agent, data);
							return next;
						});
					}
				}
			} catch (err) {
				console.warn('KV telemetry load failed (falling back to pub/sub):', err);
			}
		})();

		// Subscribe to telemetry (backward compat with pub/sub)
		const telemetrySub = nc.subscribe('mesh.telemetry.>');
		subs.push(telemetrySub);
		(async () => {
			for await (const msg of telemetrySub) {
				try {
					const data: TelemetryPayload = JSON.parse(new TextDecoder().decode(msg.data));
					telemetry.update((t) => {
						const next = new Map(t);
						next.set(data.agent, data);
						return next;
					});
				} catch { /* ignore */ }
			}
		})();

		// Subscribe to receipts
		const receiptSub = nc.subscribe('mesh.receipt.>');
		subs.push(receiptSub);
		(async () => {
			for await (const msg of receiptSub) {
				try {
					const data = JSON.parse(new TextDecoder().decode(msg.data));
					const { messageId, agent } = data;
					if (messageId && agent) {
						receipts.update((r) => {
							const next = new Map(r);
							const agents = next.get(messageId) ?? [];
							if (!agents.includes(agent)) {
								next.set(messageId, [...agents, agent]);
							}
							return next;
						});
					}
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
			publishPresence();
			presenceInterval = setInterval(publishPresence, 30000);
		}

	} catch (err) {
		console.error('NATS connection failed:', err);
		connectionStatus.set('disconnected');
		throw err;
	}
}

export async function requestSessionHistory(
	agentName: string,
	sessionKey: string,
	limit: number = 50
): Promise<SessionHistoryResponse> {
	if (!nc) throw new Error('NATS not connected');
	const subject = `mesh.session.${agentName}.history`;
	const payload = JSON.stringify({ sessionKey, limit });
	const response = await nc.request(subject, new TextEncoder().encode(payload), { timeout: 10000 });
	return JSON.parse(new TextDecoder().decode(response.data));
}

export async function sendSessionMessage(
	agentName: string,
	sessionKey: string,
	message: string
): Promise<{ reply?: string; error?: string; success: boolean }> {
	if (!nc) throw new Error('NATS not connected');
	const subject = `mesh.session.${agentName}.send`;
	const payload = JSON.stringify({ sessionKey, message });
	const response = await nc.request(subject, new TextEncoder().encode(payload), { timeout: 120000 });
	return JSON.parse(new TextDecoder().decode(response.data));
}

export async function publishMessage(text: string): Promise<string> {
	const res = await fetch('/api/send', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text, subject: 'mesh.channel.general' })
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Send failed: ${err}`);
	}
	const data = await res.json();
	return data.id;
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
