import { connect, type NatsConnection, type Subscription, credsAuthenticator } from 'nats.ws';
import { messages, presence, connectionStatus, systemEvents } from './stores.js';
import type { MessageEnvelope, PresenceInfo } from './types.js';
import { get } from 'svelte/store';

let nc: NatsConnection | null = null;
let subs: Subscription[] = [];

export async function connectNats(natsUrl: string, seed: string) {
	connectionStatus.set('connecting');

	try {
		// nats.ws uses nkey authenticator
		const { fromSeed } = await import('nkeys.js');
		const seedBytes = new TextEncoder().encode(seed);
		const kp = fromSeed(seedBytes);

		nc = await connect({
			servers: natsUrl,
			authenticator: (nonce?: Uint8Array) => {
				if (!nonce) return;
				const sig = kp.sign(nonce);
				return {
					nkey: kp.getPublicKey(),
					sig: sig
				};
			},
			reconnect: true,
			maxReconnectAttempts: -1,
			reconnectTimeWait: 2000
		});

		connectionStatus.set('connected');

		// Monitor connection status
		(async () => {
			for await (const s of nc!.status()) {
				if (s.type === 'disconnect' || s.type === 'error') {
					connectionStatus.set('disconnected');
				} else if (s.type === 'reconnect') {
					connectionStatus.set('connected');
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

	} catch (err) {
		console.error('NATS connection failed:', err);
		connectionStatus.set('disconnected');
		throw err;
	}
}

export function publishMessage(text: string) {
	if (!nc) return;

	const envelope: MessageEnvelope = {
		v: 1,
		id: crypto.randomUUID(),
		from: { agent: 'gp', type: 'human' },
		to: { subject: 'mesh.channel.general' },
		content: { text },
		ts: Math.floor(Date.now() / 1000),
		replyTo: null
	};

	nc.publish('mesh.channel.general', new TextEncoder().encode(JSON.stringify(envelope)));
}

export async function disconnectNats() {
	for (const s of subs) s.unsubscribe();
	subs = [];
	if (nc) {
		await nc.drain();
		nc = null;
	}
	connectionStatus.set('disconnected');
}
